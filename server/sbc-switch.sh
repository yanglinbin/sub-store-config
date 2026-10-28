#!/bin/sh
# 切换服务器生效的 sing-box 配置：dual（双栈，默认）| ipv4（整份只跑 IPv4）
#
# 两份主配置都由 sbc-update.sh 每天维护：
#   /etc/sing-box/config.dual.json   双栈（脚本参数 redirect=1）
#   /etc/sing-box/config.ipv4.json   纯 IPv4（redirect=1&ipv4=1）
# 本脚本只负责把选中的那份装成 /etc/sing-box/config.json 并重启，选择记在
# /etc/default/sbc-switch（sbc-update.sh 下次更新时会沿用同一个 MODE）。
#
# 用法：sbc-switch.sh            （显示当前模式）
#       sbc-switch.sh dual
#       sbc-switch.sh ipv4
set -u

CFG=/etc/sing-box/config.json
CFG_DUAL=/etc/sing-box/config.dual.json
CFG_IPV4=/etc/sing-box/config.ipv4.json
CFG_SWITCHBAK=/etc/sing-box/config.json.switchbak
MODE_FILE=/etc/default/sbc-switch

fail() {
    echo "[FAIL] $*" >&2
    exit 1
}

current_mode() {
    MODE=dual
    [ -r "$MODE_FILE" ] && . "$MODE_FILE"
    echo "${MODE:-dual}"
}

want="${1:-}"

if [ -z "$want" ] || [ "$want" = status ]; then
    echo "当前模式：$(current_mode)"
    for f in "$CFG_DUAL" "$CFG_IPV4"; do
        [ -f "$f" ] && echo "  $f  $(wc -c < "$f" | tr -d ' ') 字节"
    done
    exit 0
fi

case "$want" in
    dual) src=$CFG_DUAL ;;
    ipv4) src=$CFG_IPV4 ;;
    *) fail "用法：sbc-switch.sh [dual|ipv4|status]" ;;
esac

prev_mode=$(current_mode)

[ -s "$src" ] || fail "$src 不存在（先跑一次 sbc-update.sh 让它把两份都生成）"

# 切之前自己再验一遍：万一是被改坏的旧文件，不要在重启后才炸
sing-box check -c "$src" || fail "$src 未通过 sing-box check，未切换"

if [ -f "$CFG" ]; then
    install -o root -g sing-box -m 640 "$CFG" "$CFG_SWITCHBAK" || fail "备份当前配置到 $CFG_SWITCHBAK 失败"
fi

install -o root -g sing-box -m 640 "$src" "$CFG" || fail "写入 $CFG 失败"
printf 'MODE=%s\n' "$want" > "$MODE_FILE" || fail "写入 $MODE_FILE 失败"

systemctl restart sing-box 2>/dev/null
# Type=simple 的 restart 在 fork 后就返回，等两秒再判活
sleep 2
if systemctl is-active --quiet sing-box; then
    echo "[OK] 已切到 $want 模式并重启"
    exit 0
fi

# 起不来就退回切换前的配置，别让整机断网
if [ -f "$CFG_SWITCHBAK" ]; then
    echo "[WARN] $want 模式起不来，回滚到切换前的配置" >&2
    install -o root -g sing-box -m 640 "$CFG_SWITCHBAK" "$CFG" || fail "回滚写入 $CFG 失败"
    printf 'MODE=%s\n' "$prev_mode" > "$MODE_FILE" || true
    systemctl restart sing-box 2>/dev/null
    sleep 2
    systemctl is-active --quiet sing-box \
        || fail "回滚后仍起不来，需要人工介入（journalctl -u sing-box -n 100）"
fi
fail "切换到 $want 失败，已回滚（journalctl -u sing-box -n 50）"
