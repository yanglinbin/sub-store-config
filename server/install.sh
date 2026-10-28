#!/bin/sh
# 幂等安装器：把 server/ 里的脚本与 systemd 单元装到系统路径并启用定时任务。
#
# 用法：sudo ./server/install.sh      （可重复执行；升级代码后重跑一次即可）
#   脚本 → /usr/local/bin/*.sh            chmod 700（只有 root 能看改）
#   单元 → /etc/systemd/system/*.service,*.timer
#   启用 → sbc-update.timer / sbc-sync-dist.timer
set -u

[ "$(id -u)" -eq 0 ] || { echo "[FAIL] 需要 root：sudo $0" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd) || { echo "[FAIL] 无法定位脚本目录" >&2; exit 1; }
BIN=/usr/local/bin
UNIT_DIR=/etc/systemd/system

SCRIPTS="sbc-update.sh sbc-switch.sh sbc-sync-dist.sh"
UNITS="sbc-update.service sbc-update.timer sbc-sync-dist.service sbc-sync-dist.timer"

die() {
    echo "[FAIL] $*" >&2
    exit 1
}

# 只告警不中断：缺工具时对应脚本会在运行时报 [FAIL]，这里先提醒一次
for tool in curl git rsync sing-box systemctl; do
    command -v "$tool" >/dev/null 2>&1 || echo "[WARN] 找不到 $tool，相关功能会失败（dnf/yum install ...）" >&2
done

for s in $SCRIPTS; do
    src="$HERE/$s"
    [ -f "$src" ] || die "缺少 $src（请在 server/ 目录里执行）"
    install -o root -g root -m 700 "$src" "$BIN/$s" || die "安装 $BIN/$s 失败"
    echo "[OK] $BIN/$s"
done

# 本地配置（订阅源等）：仓库是唯一真相，重装会覆盖
if [ -f "$HERE/defaults/sbc-update" ]; then
    install -o root -g root -m 644 "$HERE/defaults/sbc-update" /etc/default/sbc-update         || die "安装 /etc/default/sbc-update 失败"
    echo "[OK] /etc/default/sbc-update"
fi
# 已存在的切换记录不覆盖（重装不该把用户选好的 dual/ipv4 改回去）
if [ -f "$HERE/defaults/sbc-switch" ] && [ ! -f /etc/default/sbc-switch ]; then
    install -o root -g root -m 644 "$HERE/defaults/sbc-switch" /etc/default/sbc-switch         || die "安装 /etc/default/sbc-switch 失败"
    echo "[OK] /etc/default/sbc-switch"
fi

for u in $UNITS; do
    src="$HERE/systemd/$u"
    [ -f "$src" ] || die "缺少 $src"
    install -o root -g root -m 644 "$src" "$UNIT_DIR/$u" || die "安装 $UNIT_DIR/$u 失败"
    echo "[OK] $UNIT_DIR/$u"
done

systemctl daemon-reload || die "systemctl daemon-reload 失败"
systemctl enable --now sbc-update.timer sbc-sync-dist.timer \
    || die "systemctl enable --now 失败（看 journalctl -xe）"

cat <<EOF

安装完成。定时任务：
  sbc-sync-dist.timer  每天 04:40  同步 dist → /data/nginx/html/sbc
  sbc-update.timer     每天 05:00  拉配置 → /etc/sing-box/config.json → 重启 sing-box

还剩三步需要人工做（脚本不碰你的 nginx 配置，避免改坏在跑的站点）：
  1. 把 $HERE/nginx/sbc-static.conf 贴进 /data/nginx/conf/ 下
     sub-store.yilabao.top 的 443 server 块，位置放在已有的 location / 之前；
     然后校验并重载容器里的 nginx：
       docker exec <nginx 容器名> nginx -t
       docker exec <nginx 容器名> nginx -s reload
     验证：curl -I https://sub-store.yilabao.top/sbc/build-info.json   → 200
  2. 手动跑一次两个脚本，确认输出是 [OK] 而不是 [FAIL]：
       /usr/local/bin/sbc-sync-dist.sh
       /usr/local/bin/sbc-update.sh
  3. 回 GitHub 仓库把变量 RULES_BASE_URL 设成 https://sub-store.yilabao.top/sbc，
     下一次 CI 构建的 dist 就会从自己的域名拉规则集。

排查：
  systemctl list-timers 'sbc-*'
  journalctl -u sbc-update -u sbc-sync-dist -n 50
EOF
