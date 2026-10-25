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
CFG=/etc/sing-box/config.json
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

# 内容没变就别重启：重启会掐断所有连接，没必要
if [ -f "$CFG" ] && cmp -s "$TMP" "$CFG"; then
    echo "[OK] 配置无变化（$nodes 个节点），跳过重启"
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
install -o root -g sing-box -m 640 "$TMP" "$CFG" || fail "写入 $CFG 失败"

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


echo "[OK] 配置已更新并重启：$nodes 个节点"
