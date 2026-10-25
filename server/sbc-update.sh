#!/bin/sh
# 每天从 Sub-Store 拉一份 sing-box 配置，通过四道闸后原子替换并重启 sing-box。
#
# 设计原则：宁可继续用旧配置，也不用半份坏配置。任何一道闸没过都只 echo [FAIL] + exit 1，
# /etc/sing-box/config.json 一个字节都不动（替换是最后一步的 install）。
#
# 用法：sbc-update.sh            （由 sbc-update.timer 每天 05:00 调用，也可手动跑）
#       SUBSTORE_FILE_URL=... sbc-update.sh
set -u

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
curl -fsS --retry 3 -o "$TMP" "$SUBSTORE_FILE_URL" || fail "下载失败：$SUBSTORE_FILE_URL"

# 闸 2：形状。Sub-Store 出错时会返回 HTML 错误页或 JSON 报错体，先挡住
head -c 1 "$TMP" | grep -q '{' || fail "响应不是以 { 开头（Sub-Store 报了 HTML？）"
grep -q '"outbounds"' "$TMP" || fail "响应里没有 outbounds 字段"
grep -q '"route"' "$TMP" || fail "响应里没有 route 字段"

# 闸 3：节点数。注意只能数 server_port：rule_set 里也有 "type": "remote"，
# 旧版用 grep -c '"type": "remote"' 会把它当成节点，节点全掉光也照样替换
nodes=$(grep -c '"server_port"' "$TMP")
[ "$nodes" -ge "$MIN_NODES" ] || fail "节点数只有 $nodes 个（< $MIN_NODES），疑似订阅异常"

# 闸 4：语法。sing-box 自己说能加载才算数（还能顺带挡住端口/字段改错）
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

systemctl restart sing-box || fail "systemctl restart sing-box 失败（旧配置已备份，可用回滚命令恢复）"
systemctl is-active --quiet sing-box || fail "重启后 sing-box 未处于 active（检查 journalctl -u sing-box -n 50）"

echo "[OK] 配置已更新并重启：$nodes 个节点"
