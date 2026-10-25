#!/bin/sh
# 让 Docker 容器流量走 sing-box 的 TUN（仅宿主机 Linux）。
#
# 为什么需要：sing-box 的 tun 只接管「宿主机自己」的流量；容器从 172.17/18/19 主动出网时，
# 源地址是容器网段，内核按主表把它从 eth0 发出去，代理完全绕开。本脚本用 ip rule 把
# 这几个网段指到 sing-box 的路由表（2022，由 tun 的 auto_route 维护），
# 并给「发布端口的回程包」打 conntrack mark，让它们继续走主表——否则 DNAT 进来的访问
# （例如 80/443 的站点）回包会钻进 tun，从别人家出口回去，TCP 直接断。
#
# 与 tun.auto_redirect（sing-box 官方方案）是等价的两层手段，别同时上：见 README
# 「让 Docker 容器也走代理（仅 Linux 服务器）」。
#
# 用法：docker-via-tun.sh up|down     幂等，可反复执行
#   up    安装全部规则；tun0 不存在（sing-box 没起）时退化为「容器继续直连」并告警
#   down  删除全部规则，容器恢复直连
set -u

# 容器网段：Docker 默认地址池是 172.17–172.31，这里列出本机实际在用的三个
SUBNETS="${SUBNETS:-172.17.0.0/16 172.18.0.0/16 172.19.0.0/16}"
# 私网：容器访问局域网/宿主机服务时不该进 tun，直接走主表
PRIVATE="${PRIVATE:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"
# 发布端口回程包的 mark。/mask：只写 0x233 命中的那几个位，避免覆盖别人打的 mark
MARK=0x233
MARK_MASK="$MARK/$MARK"   # ip rule 里必须带掩码，否则按整 32 位精确匹配

TUN=tun0
TUN_TABLE=2022

PRIO_MARK=90        # 带 mark 的包走主表（最小的优先级数字最先匹配）
PRIO_TO_PRIVATE=98  # 容器 → 私网 走主表
PRIO_TO_TUN=100     # 容器 → 其它一切 走 tun 表
PRIO_FALLBACK=8000  # tun 不存在时的兜底：主表（等价于不接管）

die() {
    echo "[FAIL] $*" >&2
    exit 1
}

# 反复删除同一条 ip rule 直到删不动：历史上叠出来的重复项一次清干净，且不误删别人的规则
del_rule() {
    while ip rule del "$@" 2>/dev/null; do :; done
}

# 先删后加：重复执行不会叠加
add_rule() {
    del_rule "$@"
    ip rule add "$@" || die "ip rule add $* 失败"
}

# 清掉本脚本可能留下的所有规则（up 的开头与 down 共用）
flush_rules() {
    del_rule fwmark "$MARK_MASK" lookup main pref "$PRIO_MARK"
    # 早期版本写的是无掩码形式（掩码 0xffffffff），掩码不同 → 上面那条删不掉，单独清一次
    del_rule fwmark "$MARK/0xffffffff" lookup main pref "$PRIO_MARK"
    for net in $SUBNETS; do
        del_rule from "$net" lookup "$TUN_TABLE" pref "$PRIO_TO_TUN"
        del_rule from "$net" lookup main pref "$PRIO_FALLBACK"
        for pnet in $PRIVATE; do
            del_rule from "$net" to "$pnet" lookup main pref "$PRIO_TO_PRIVATE"
        done
    done
}

mark_of() {
    echo "$MARK/$MARK"
}

up() {
    command -v iptables >/dev/null 2>&1 || die "找不到 iptables（本脚本要求 iptables-legacy/nft 兼容层）"
    command -v ip >/dev/null 2>&1 || die "找不到 ip（安装 iproute2）"

    flush_rules

    # 1) 发布端口的回程保护：被 DNAT 过的连接两个方向的包都打 mark
    while iptables -t mangle -D PREROUTING -m conntrack --ctstate DNAT -j MARK --set-xmark "$(mark_of)" 2>/dev/null; do :; done
    iptables -t mangle -A PREROUTING -m conntrack --ctstate DNAT -j MARK --set-xmark "$(mark_of)" \
        || die "iptables mangle PREROUTING 加 mark 规则失败"

    # 2) 带 mark 的包先看主表（优先级 90 < 98 < 100，所以先于下面两条生效）
    add_rule fwmark "$MARK_MASK" lookup main pref "$PRIO_MARK"

    # 3) 每个容器网段：私网直连 + 其余交给 tun 表
    for net in $SUBNETS; do
        for pnet in $PRIVATE; do
            add_rule from "$net" to "$pnet" lookup main pref "$PRIO_TO_PRIVATE"
        done
    done

    # 4) 守卫：sing-box 没起时 tun0 不存在，此时把容器流量指向 tun 表等于黑洞（容器全断网）。
    #    这种情况改为「容器继续直连」，只保证不断网，等 sing-box 起来后重跑本脚本。
    # 开机时 After=sing-box 只保证"已启动"，tun0 往往还要几百毫秒才建好：等最多 10 秒
    i=0
    while [ "$i" -lt 20 ]; do
        ip link show "$TUN" >/dev/null 2>&1 && [ -n "$(ip route show table "$TUN_TABLE" 2>/dev/null)" ] && break
        i=$((i + 1))
        sleep 0.5
    done

    if ip link show "$TUN" >/dev/null 2>&1 && [ -n "$(ip route show table "$TUN_TABLE" 2>/dev/null)" ]; then
        for net in $SUBNETS; do
            add_rule from "$net" lookup "$TUN_TABLE" pref "$PRIO_TO_TUN"
        done
        echo "[OK] 容器网段已指向 $TUN（表 $TUN_TABLE）：$SUBNETS"
    else
        for net in $SUBNETS; do
            add_rule from "$net" lookup main pref "$PRIO_FALLBACK"
        done
        echo "[WARN] 找不到 $TUN 或表 $TUN_TABLE 没有路由（sing-box 未启动？）：本次只保证容器不断网，流量仍走主表直连。" >&2
        echo "[WARN] sing-box 起来后重跑：systemctl restart docker-via-tun.service" >&2
    fi
}

down() {
    command -v iptables >/dev/null 2>&1 || die "找不到 iptables"
    flush_rules
    while iptables -t mangle -D PREROUTING -m conntrack --ctstate DNAT -j MARK --set-xmark "$(mark_of)" 2>/dev/null; do :; done
    echo "[OK] 已移除容器分流规则（容器恢复直连）"
}

case "${1:-}" in
    up) up ;;
    down) down ;;
    *)
        echo "用法: $0 up|down" >&2
        exit 2
        ;;
esac
