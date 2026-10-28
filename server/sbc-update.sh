#!/bin/sh
# 每天从 Sub-Store 拉一份 sing-box 配置，通过四道闸后原子替换并重启 sing-box。
#
# 设计原则：宁可继续用旧配置，也不用半份坏配置。任何一道闸没过都只 echo [FAIL] + exit 1，
# /etc/sing-box/config.json 一个字节都不动（替换是最后一步的 install）。
#
# 用法：sbc-update.sh            （由 sbc-update.timer 每天 05:00 调用，也可手动跑）
#       SUBSTORE_FILE_URL=... sbc-update.sh
set -u

# 订阅源优先级：环境变量 > /etc/default/sbc-update > 内置默认（桌面共用文件）
# /etc/default 里还有 REQUIRE_AUTO_REDIRECT 等开关，所以**总是**读它；
# 但作业环境显式给的 SUBSTORE_FILE_URL 优先（便于临时换源排障）
if [ -r /etc/default/sbc-update ]; then
    _env_url="${SUBSTORE_FILE_URL:-}"
    # shellcheck disable=SC1091
    . /etc/default/sbc-update
    [ -n "$_env_url" ] && SUBSTORE_FILE_URL="$_env_url"
    unset _env_url
fi
SUBSTORE_FILE_URL="${SUBSTORE_FILE_URL:-}"
SUBSTORE_FILE_URL="${SUBSTORE_FILE_URL:-https://sub-store.yilabao.top/cdc1dc50c1a6799f49c87914ef77def3/api/file/singbox}"
# IPv4 副本的订阅源：同一 Sub-Store 下的 singbox-server-ipv4 文件；
# 没配置就从主源推导（只换文件名），实在推导不出来就跳过 IPv4 副本
SUBSTORE_FILE_URL_IPV4="${SUBSTORE_FILE_URL_IPV4:-}"
if [ -z "$SUBSTORE_FILE_URL_IPV4" ]; then
    case "$SUBSTORE_FILE_URL" in
        */api/file/*)
            SUBSTORE_FILE_URL_IPV4="${SUBSTORE_FILE_URL%%/api/file/*}/api/file/singbox-server-ipv4?noCache=true"
            ;;
    esac
fi
CFG=/etc/sing-box/config.json
CFG_DUAL=/etc/sing-box/config.dual.json   # 双栈主配置（本脚本维护，不直接生效）
CFG_IPV4=/etc/sing-box/config.ipv4.json   # IPv4-only 主配置（同模板 + 脚本参数 ipv4=1）
MODE_FILE=/etc/default/sbc-switch         # 记着当前要用哪份：MODE=dual | ipv4
BAK_GLOB=/etc/sing-box/config.json.bak
MIN_NODES=5   # 少于这么多个节点说明机场掉线或脚本出错，不能替换
KEEP_BAK=3    # 只保留最近几份备份

TMP=$(mktemp /tmp/sbc-update.XXXXXX) || { echo "[FAIL] mktemp 失败" >&2; exit 1; }
trap 'rm -f "$TMP"' EXIT INT TERM

fail() {
    echo "[FAIL] $*" >&2
    echo "[FAIL] 配置未替换，sing-box 继续使用旧配置" >&2
    exit 1
}

# IPv4 副本：同一模板加脚本参数 ipv4=1 的产物（tun 只留 v4 地址、fakeip 去掉 inet6_range、
# dns.strategy=ipv4_only），供 sbc-switch.sh 切换用。
# 它是副产物：任何一步不过都只告警、保留旧文件，绝不让它挡住双栈主配置的更新。
MODE=dual
[ -r "$MODE_FILE" ] && . "$MODE_FILE"
MODE="${MODE:-dual}"

update_ipv4() {
    [ -n "$SUBSTORE_FILE_URL_IPV4" ] || { echo "[WARN] 未配置 IPv4 副本源，跳过" >&2; return 0; }
    _t=$(mktemp /tmp/sbc-update-ipv4.XXXXXX) || { echo "[WARN] mktemp 失败，跳过 IPv4 副本" >&2; return 0; }
    if ! curl -fsS --retry 3 --connect-timeout 10 --max-time 120 -o "$_t" "$SUBSTORE_FILE_URL_IPV4"; then
        echo "[WARN] IPv4 副本下载失败（保留旧文件）：$SUBSTORE_FILE_URL_IPV4" >&2
        rm -f "$_t"; return 0
    fi
    if ! head -c 16 "$_t" | tr -d '[:space:]' | grep -q '^{' || ! grep -q '"outbounds"' "$_t"; then
        echo "[WARN] IPv4 副本不是合法配置（保留旧文件）" >&2
        rm -f "$_t"; return 0
    fi
    _n=$(grep -o '"server_port"' "$_t" | wc -l)
    if [ "$_n" -lt "$MIN_NODES" ]; then
        echo "[WARN] IPv4 副本只有 $_n 个节点（< $MIN_NODES），保留旧文件" >&2
        rm -f "$_t"; return 0
    fi
    if [ "${REQUIRE_AUTO_REDIRECT:-0}" = 1 ] && ! grep -q '"auto_redirect": *true' "$_t"; then
        echo "[WARN] IPv4 副本没有 auto_redirect（订阅源应指向 singbox-server-ipv4），保留旧文件" >&2
        rm -f "$_t"; return 0
    fi
    # 挡住“ipv4=1 参数没传成功”这种静默退化：副本必须真的是 ipv4_only
    if ! grep -q '"strategy": *"ipv4_only"' "$_t"; then
        echo "[WARN] IPv4 副本不是 ipv4_only（脚本参数漏了 ipv4=1？），保留旧文件" >&2
        rm -f "$_t"; return 0
    fi
    if ! sing-box check -c "$_t"; then
        echo "[WARN] IPv4 副本 sing-box check 未通过，保留旧文件" >&2
        rm -f "$_t"; return 0
    fi
    if [ -f "$CFG_IPV4" ] && cmp -s "$_t" "$CFG_IPV4"; then
        echo "[OK] IPv4 配置无变化（$_n 个节点）"
        rm -f "$_t"; return 0
    fi
    if install -o root -g sing-box -m 640 "$_t" "$CFG_IPV4"; then
        echo "[OK] IPv4 配置已就绪：$CFG_IPV4（$_n 个节点）"
    else
        echo "[WARN] 写入 $CFG_IPV4 失败" >&2
    fi
    rm -f "$_t"
}

# 闸 1：下载。--retry 3 让偶发 5xx/超时自愈，-f 让 4xx/5xx 变成非零退出码
curl -fsS --retry 3 --connect-timeout 10 --max-time 120 -o "$TMP" "$SUBSTORE_FILE_URL" || fail "下载失败：$SUBSTORE_FILE_URL"

# 闸 2：形状。Sub-Store 出错时会返回 HTML 错误页或 JSON 报错体，先挡住
head -c 16 "$TMP" | tr -d '[:space:]' | grep -q '^{' || fail "响应不是以 { 开头（Sub-Store 报了 HTML？）"
grep -q '"outbounds"' "$TMP" || fail "响应里没有 outbounds 字段"
grep -q '"route"' "$TMP" || fail "响应里没有 route 字段"

# 闸 3：节点数。注意只能数 server_port：rule_set 里也有 "type": "remote"，
# 旧版用 grep -c '"type": "remote"' 会把它当成节点，节点全掉光也照样替换
# 用 grep -o + wc -l 数"出现次数"：grep -c 数的是行数，紧凑 JSON 会永远得到 1
nodes=$(grep -o '"server_port"' "$TMP" | wc -l)
[ "$nodes" -ge "$MIN_NODES" ] || fail "节点数只有 $nodes 个（< $MIN_NODES），疑似订阅异常"

# 闸 4：服务器模式必须带 auto_redirect。不校验的话，订阅源指错成桌面共用文件时，
# 新配置会静默生效 —— 容器从此不再走代理（且没有任何报错），这正是最难查的故障
if [ "${REQUIRE_AUTO_REDIRECT:-0}" = 1 ]; then
    grep -q '"auto_redirect": *true' "$TMP"         || fail "配置里没有 auto_redirect（订阅源应指向 singbox-server 文件，而不是桌面共用的 singbox）"
fi

# 闸 5：语法。sing-box 自己说能加载才算数（还能顺带挡住端口/字段改错）
sing-box check -c "$TMP" || fail "sing-box check 未通过"

# ---- 两份主配置都维护：双栈这份就是刚过闸的内容 ----
install -o root -g sing-box -m 640 "$TMP" "$CFG_DUAL" || fail "写入 $CFG_DUAL 失败"
echo "[OK] 双栈配置已就绪：$CFG_DUAL（$nodes 个节点）"
update_ipv4

# ---- 生效哪份由 MODE 决定（sbc-switch.sh 切）----
ACTIVE_SRC="$TMP"
case "$MODE" in
    ipv4|6)
        [ -s "$CFG_IPV4" ] || fail "MODE=ipv4 但 $CFG_IPV4 不可用（先看上面 IPv4 副本的告警）"
        ACTIVE_SRC="$CFG_IPV4"
        ;;
    *)
        MODE=dual
        ;;
esac

# 内容没变就别重启：重启会掐断所有连接，没必要
if [ -f "$CFG" ] && cmp -s "$ACTIVE_SRC" "$CFG"; then
    echo "[OK] 配置无变化（$nodes 个节点，MODE=$MODE），跳过重启"
    exit 0
fi

# 备份（只留最近 KEEP_BAK 份）
if [ -f "$CFG" ]; then
    BAK="$BAK_GLOB.$(date +%Y%m%d-%H%M%S)"
    cp -p "$CFG" "$BAK" || fail "备份到 $BAK 失败"
    # shellcheck disable=SC2012  # 备份名里的时间戳可直接排序，不需要 find -printf
    ls -1t "$BAK_GLOB".* 2>/dev/null | tail -n +$((KEEP_BAK + 1)) | xargs -r rm -f
    echo "[OK] 已备份旧配置：$BAK"
fi

# 替换：属主 root:sing-box 640，sing-box 服务（User=sing-box）才能读到
install -o root -g sing-box -m 640 "$ACTIVE_SRC" "$CFG" || fail "写入 $CFG 失败"

restart_or_rollback() {
    systemctl restart sing-box 2>/dev/null
    # Type=simple 的 restart 在 fork 后就返回，进程可能在几百毫秒后才退出，采样一次会漏判
    i=0
    while [ "$i" -lt 10 ]; do
        sleep 1
        i=$((i + 1))
        systemctl is-active --quiet sing-box || break
    done
    systemctl is-active --quiet sing-box && return 0
    # 起不来就回滚到上一份，避免整机因为一份坏配置长时间断网
    prev=$(ls -1t "$BAK_GLOB".* 2>/dev/null | head -1)
    [ -n "$prev" ] || fail "重启后 sing-box 未处于 active，且没有可回滚的备份（检查 journalctl -u sing-box -n 50）"
    echo "[WARN] 新配置起不来，回滚到 $prev" >&2
    install -o root -g sing-box -m 640 "$prev" "$CFG" || fail "回滚写入 $CFG 失败"
    systemctl restart sing-box 2>/dev/null
    i=0
    while [ "$i" -lt 10 ]; do
        sleep 1
        i=$((i + 1))
        systemctl is-active --quiet sing-box && break
    done
    systemctl is-active --quiet sing-box         || fail "回滚后仍起不来，需要人工介入（journalctl -u sing-box -n 100）"
    fail "新配置导致 sing-box 无法启动，已自动回滚到 $prev"
}

restart_or_rollback


echo "[OK] 配置已更新并重启：$nodes 个节点（MODE=$MODE）"
