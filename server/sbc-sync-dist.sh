#!/bin/sh
# 把 dist 分支同步到 nginx 的静态目录，让客户端从自己的域名拉规则集
# （https://sub-store.yilabao.top/sbc/...），不再依赖 jsDelivr/GitHub raw。
#
# dist 分支是 CI 每天强推的「单 commit」分支，所以永远 --depth 1 -f 覆盖，
# 不做 merge、不保留历史。nginx 容器把宿主的 /data/nginx/html 挂成 /usr/share/nginx/html，
# 因此 DEST 在容器里看就是 /usr/share/nginx/html/sbc/。
#
# 用法：sbc-sync-dist.sh       （由 sbc-sync-dist.timer 每天 04:40 调用，也可手动跑）
set -u

REPO="${REPO:-https://github.com/yanglinbin/sub-store-config.git}"
BR=dist
SRC=/opt/sbc-dist
DEST=/data/nginx/html/sbc
MIN_SRS=15   # 规则集模块共 17 个，少于 15 个说明构建/拉取出了问题

die() {
    echo "[FAIL] $*" >&2
    exit 1
}

command -v git >/dev/null 2>&1 || die "找不到 git"
command -v rsync >/dev/null 2>&1 || die "找不到 rsync"

# 1) 取分支：首次 clone，之后强制对齐到远端（dist 只有一个 commit）
#    git 走 sing-box 的 tun 出去；tun0 刚重建的几秒内 TCP 会悬着，
#    lowSpeedTime 让"连不上"在 20 秒内失败，再由外层重试
GIT="git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20"
export GIT_TERMINAL_PROMPT=0

fetch_once() {
    if [ -d "$SRC/.git" ]; then
        $GIT -C "$SRC" fetch --depth 1 --force origin "$BR" || return 1
        $GIT -C "$SRC" reset --hard FETCH_HEAD || return 1
        $GIT -C "$SRC" clean -fdx || return 1
    else
        mkdir -p "$(dirname "$SRC")" || return 1
        $GIT clone -b "$BR" --depth 1 "$REPO" "$SRC" || return 1
    fi
    git -C "$SRC" rev-parse --verify -q HEAD >/dev/null
}

i=0
while [ "$i" -lt 3 ]; do
    i=$((i + 1))
    fetch_once && break
    if [ "$i" -lt 3 ]; then
        echo "[WARN] 第 $i 次取 dist 失败（网络/tun 未就绪？），5 秒后重试" >&2
        sleep 5
    fi
done
[ -d "$SRC/.git" ] && git -C "$SRC" rev-parse --verify -q HEAD >/dev/null \
    || die "git fetch/clone 连续 3 次失败（网络或仓库地址不对）"

# 2) sanity：宁可让站点停在上一次的内容，也不 rsync 一份残缺产物（--delete 会把旧文件删光）
[ -f "$SRC/build-info.json" ] || die "$SRC/build-info.json 不存在，dist 分支产物不完整"
srs=$(find "$SRC/singbox/rules" -maxdepth 1 -type f -name '*.srs' 2>/dev/null | wc -l)
[ "$srs" -ge "$MIN_SRS" ] || die "$SRC/singbox/rules 只有 $srs 个 .srs（< $MIN_SRS），产物不完整"

# 3) 部署。--delete 让远端删掉的模块也从站点消失；排除 .git 免得把仓库历史暴露出去
mkdir -p "$DEST" || die "创建 $DEST 失败"
rsync -a --delete --exclude '.git' "$SRC/" "$DEST/" || die "rsync 到 $DEST 失败"
# nginx 容器里的 worker 是 nginx 用户，靠 o+rX 才读得到
chmod -R a+rX "$DEST" || die "chmod 失败"

echo "[OK] dist 已同步到 $DEST（$srs 个 .srs，commit $(git -C "$SRC" rev-parse --short HEAD)）"
