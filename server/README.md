# 服务器运维资产（阿里云 Linux + sing-box systemd + nginx 容器）

这里的全部内容只影响**这台服务器怎么跑**，不影响规则语义、也不改 `dist` 的发布流程
（CI 仍然构建并强推 `dist` 分支，见 `.github/workflows/build.yml`）。

服务器前提：

| 项 | 值 |
|---|---|
| sing-box | systemd 托管，unit 自带 `User=sing-box`，启动参数 `-C /etc/sing-box`，配置 `/etc/sing-box/config.json`，TUN 接口 `tun0` |
| Docker | 网段 `172.17.0.0/16` `172.18.0.0/16` `172.19.0.0/16` |
| nginx | 容器，宿主 `/data/nginx/html` → 容器 `/usr/share/nginx/html`，站点配置 `/data/nginx/conf/*.conf`，`sub-store.yilabao.top` 已有 443 server 块 |

## 清单

| 文件 | 做什么 |
|---|---|
| `defaults/sbc-update` | 装到 `/etc/default/sbc-update`：指定订阅源为服务器专用文件（`…/api/file/singbox-server`，带 `redirect=1`） |
| `sbc-update.sh` | 从 Sub-Store 拉最新的 sing-box 配置，过五道闸（下载 / 形状 / 节点数≥5 / `auto_redirect` 必须存在 / `sing-box check`）后原子替换并重启；内容没变则不重启。订阅源优先级：环境变量 > `/etc/default/sbc-update` > 内置默认 |
| `sbc-sync-dist.sh` | 把 `dist` 分支（单 commit，强推）同步到 `/data/nginx/html/sbc`，让客户端从本站拉 `.srs`；工作副本在 `/opt/sbc-dist`（可随时删掉重建）；完整性闸口：`.srs` 少于 15 个就 `die`，旧产物原样保留 |
| `install.sh` | 幂等安装：脚本 → `/usr/local/bin`（700）、单元 → `/etc/systemd/system`、`defaults/sbc-update` → `/etc/default/`、`daemon-reload`、启用 2 个 timer |
| `systemd/sbc-update.service` | `oneshot`，跑 `sbc-update.sh` |
| `systemd/sbc-update.timer` | `OnCalendar=*-*-* 05:00:00`、`Persistent=true`、`RandomizedDelaySec=300` |
| `systemd/sbc-sync-dist.service` | `oneshot`，跑 `sbc-sync-dist.sh` |
| `systemd/sbc-sync-dist.timer` | 同上，`OnCalendar=*-*-* 04:40:00`（早于更新，先刷静态站点） |
| `nginx/sbc-static.conf` | 片段：`location /sbc/` 别名到静态目录 |

## 流量分层

```
                         ┌──────────────────────────────────────────────────────┐
  宿主进程（curl 等）     │  nft: inet sing-box 打 mark ─┐                        │
  容器（172.17/18/19）    │  出网在 PREROUTING 即被接管 ─┤→ ip rule 9000+ → 表 2022 │──► tun0 ──► 节点
                         │  （按 mark，不按网段）       ┘                        │
                         │                                                      │
  外部访问容器发布端口    │  nft: ct status dnat → mark 0x233 → 命中 "local" 表    │──► eth0 直出
                         └──────────────────────────────────────────────────────┘
```

三类流量：宿主和容器**出网**走 tun0 → 节点；被 DNAT 过的**端口回程**走主表直出
（否则回包会从节点出口回去，TCP 直接断）；容器访问私网同样落在主表。

这是 sing-box 官方的 `auto_redirect`（1.10+，仅 Linux，需要 `auto_route`）：用 nftables + mark 实现，
启动时自动插入 Docker 兼容规则（`ct status dnat → mark 0x233`）。规则全在 sing-box 里，重启即重建：

- `ip rule`：`9000/9001/9002/32768`（sing-box 维护，**不再有** 90/98/100）
- `nft`：`table inet sing-box` + `ip mangle` 里的 Docker 兼容规则
- 新增容器网段无需改任何脚本

这是**唯一方案**。早期手写的 `ip rule` + `conntrack mark` 脚本（`docker-via-tun.sh`）已删除 ——
需要时从 git 历史取回，但先确认内核/`nft` 为什么不可用。


## 安装（三步）

```bash
# 1. 装脚本与单元（幂等，升级后重跑一次即可）
sudo ./server/install.sh

# 2. 把 nginx 片段贴进 sub-store.yilabao.top 的 443 server 块（location / 之前），重载
#    server/nginx/sbc-static.conf 的内容：
#    location /sbc/ { alias /usr/share/nginx/html/sbc/; ... }
docker exec <nginx 容器名> nginx -t && docker exec <nginx 容器名> nginx -s reload

# 3. 手动跑一次，确认输出是 [OK]
sudo /usr/local/bin/sbc-sync-dist.sh
sudo /usr/local/bin/sbc-update.sh
```

`install.sh` 的告警（找不到 `git`/`rsync`/`sing-box` 等）只是提示，对应脚本运行时才会真失败。

## 日常运维

| 想做的事 | 命令 |
|---|---|
| 立刻刷新静态站点 | `sudo systemctl start sbc-sync-dist.service`（或 `sudo /usr/local/bin/sbc-sync-dist.sh`） |
| 立刻重拉配置 | `sudo systemctl start sbc-update.service`（或 `sudo /usr/local/bin/sbc-update.sh`） |
| 看重启/同步日志 | `journalctl -u sbc-update -u sbc-sync-dist -n 100` / `journalctl -u sing-box -n 100` |
| 看定时器下次触发 | `systemctl list-timers 'sbc-*'` |
| 临时换订阅源/仓库 | `SUBSTORE_FILE_URL=… sbc-update.sh`、`REPO=… sbc-sync-dist.sh` |
| 回滚配置 | `sudo install -o root -g sing-box -m 640 /etc/sing-box/config.json.bak.<时间戳> /etc/sing-box/config.json && sudo systemctl restart sing-box` |
| 备份清单 | `ls -1t /etc/sing-box/config.json.bak.*`（只保留最近 3 份） |
| 静态目录直接看 | `ls /data/nginx/html/sbc`、`curl -I https://sub-store.yilabao.top/sbc/build-info.json` |

## 自托管规则集

- 仓库变量 `RULES_BASE_URL = https://sub-store.yilabao.top/sbc` → CI 构建时 `BASE_URL` 用它，
  客户端配置里的 17 个 `rule_set.url` / `rule-provider.url` 全部指向自己域名。
- 因此 `sbc-sync-dist.sh` 必须跑在**构建之后**。定时器按**服务器本地时间**：04:40 同步 dist、05:00 拉配置；
  CI 的日构建是 04:00 UTC（服务器 UTC+8 时＝当天 12:00），push 后可手动 `systemctl start sbc-sync-dist.service` 立刻生效。
- 静态站点挂了不会让客户端起不来：`.srs` 有 `cache_file` / `interval: 86400` 本地缓存；
  真出事可把 `RULES_BASE_URL` 改回 jsDelivr 的 `https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist` 重跑 CI。
- Sub-Store 里 `clash` / `singbox` 两个文件的模板与脚本 URL 也已指向自己域名，
  `singbox` 使用**直连变体** `template.json`（规则集就在本机 nginx，不需要经代理下载），
  因此 sing-box 启动不再依赖「节点必须活着」。

## 故障模式

| 症状 | 原因 | 处理 |
|---|---|---|
| 客户端能连上但 DNS 结果全 `198.18.x` 却打不开网页 | fakeip 必须配 TUN：只用 `mixed-in` 而关掉 tun 时，fakeip 域名没有设备承载 | 保留 tun 入站；或用 `noCache=true` 且不启用 fakeip 的变体 |
| 外部访问容器发布的端口（80/443）连上就断 | DNAT 回程包被拉进 tun，从节点出口回去 | 确认 `nft list ruleset \| grep "ct status dnat"` 有 Docker 兼容规则、`table inet sing-box` 存在；`systemctl restart sing-box` 会重建 |
| 容器完全断网 | 订阅源指错成桌面共用文件（配置里没有 `auto_redirect`），容器悄悄退回直连 | `sbc-update` 有强制闸会拒绝这种配置；手工排查：`grep -c '"auto_redirect": true' /etc/sing-box/config.json` 应为 1 |
| 客户端 Windows 上配置 `FATAL`：`auto_redirect is only supported on Linux` | `auto_redirect` 仅 Linux 支持，写进共用模板会让桌面端失败 | 模板保持不带该字段，只在服务器链接上用 `&redirect=1` 注入（见主 README） |
| `sbc-update` 天天 `[FAIL] 节点数只有 0 个` | 订阅失效/机场面板改路径 | 修 Sub-Store 订阅；脚本不会替换旧配置，服务仍在跑 |
| 站点 404 `/sbc/...` | nginx 片段没贴或没 reload，或 `sbc-sync-dist` 没跑过 | `curl -I …/sbc/build-info.json`；`journalctl -u sbc-sync-dist` |
