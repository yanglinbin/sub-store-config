# sub-store-config

用 Sub-Store 一条链接下发**完整可跑的配置**（mihomo / sing-box 各一条），规则集自建、模块化、可 git 追溯。

- 节点：只来自你的机场订阅，Sub-Store 负责过滤/去重/排序
- 规则：唯一上游 `Loyalsoldier/clash-rules`，两端同源（`rules/order.yaml` + `rules/modules.yaml`）
- 策略组：极简 `proxies` / `f1tv` / `direct` / `final` + 按地区自动生成的节点组
- 产物：CI 构建后推 `dist` 分支，Sub-Store 直接引用

设计文档：`docs/superpowers/specs/2026-10-23-substore-config-design.md`
实施计划：`docs/superpowers/plans/2026-10-23-substore-config.md`

---

## 规则集（17 个模块）

| # | 模块 | 来源 | 类型 | → 组 |
|---|---|---|---|---|
| 1 | `category-ads-all` | clash-rules `reject.txt` | domain | **reject** |
| 2 | `private` | clash-rules `private.txt` | domain | direct |
| 3 | `lancidr` | clash-rules `lancidr.txt` | ipcidr | direct |
| 4 | `f1tv` | 自建 | classical | **f1tv** |
| 5 | `microsoft` | 自建（含 2 条 KEYWORD） | classical | direct |
| 6 | `apple` | clash-rules `apple.txt` | domain | direct |
| 7 | `icloud` | clash-rules `icloud.txt` | domain | direct |
| 8 | `steam` | 自建（4 域名 + 40 CIDR） | classical | direct |
| 9 | `applications` | clash-rules（98 条进程） | classical | direct |
| 10 | `google` | clash-rules **`google.txt`**（112 条，大陆可连的 Google 域名） | domain | **proxies** |
| 11 | `gfw` | clash-rules `gfw.txt` | domain | **proxies** |
| 12 | `direct` | clash-rules `direct.txt` | domain | direct |
| 13 | `proxy` | clash-rules `proxy.txt` | domain | **proxies** |
| 14 | `lancidr` | clash-rules `lancidr.txt` | ipcidr | direct |
| 15 | `cncidr` | clash-rules `cncidr.txt` | ipcidr | direct |
| 16 | `telegramcidr` | clash-rules `telegramcidr.txt` | ipcidr | **proxies** |

未命中 → `final` 组。**两端都有兜底**：mihomo 末尾追加 `MATCH,final`，sing-box 用 `route.final: "final"`。

**Google 的走向**：`google` 模块直接引用上游 `google.txt`（112 条，官方维护的"Google 在大陆可直连域名"，
含 `2mdn-cn.net`、`admob-cn.com`、`redirector.xn--ngstr-lra8j.com` 等）→ `proxies`；
`gfw` 里另有 251 条 Google/YouTube 域名做补充。两者都排在所有 IP 规则之前。
唯一剩下的例外是 `gstatic.cn`（上游哪张表都没有，会被 `cncidr` 判成直连）。

**为什么 IP 规则排在所有域名规则之后**：sing-box 的 `{action: resolve}` 会强制解析目标域名
（fakeip 模式下必须解析才能匹配 `ipcidr`）。把它放在域名规则之后，只有"哪张域名表都没进"的连接才付这次解析，
同时避免把要代理的域名先送去本地 DNS 污染一遍——被污染的 IP 也就不会让 `cncidr` 把代理域名抢成直连。

sing-box 侧的前置/插入动作（不随 `order.yaml` 变化）：

```json
{"action":"sniff"},                        // 识别域名/协议
{"action":"hijack-dns","protocol":"dns"},  // 53 端口的 DNS 拉进 sing-box
...15 条规则...                             // 第 9/10/11/12/13 条之后自动插入 ↓
{"action":"resolve","server":"local-dns"}, // 只对没命中域名规则的连接生效
...lancidr / cncidr / telegramcidr...
```

### 让 Docker 容器也走代理（仅 Linux 服务器）

`auto_redirect` 是 sing-box 官方给的方案（文档原话：*avoids conflicts between TUN and Docker bridge networks*），
但它**只支持 Linux**：把该字段写进共用模板会让 Windows 客户端的配置直接 `FATAL`（实测 1.14.3：
`initialize inbound[0]: auto_redirect is only supported on Linux`）。

所以模板保持共用，由脚本按参数注入：

```
…/scripts/singbox.js#name=default&noCache=true&redirect=1     ← 服务器（Linux）
…/scripts/singbox.js#name=default&noCache=true                ← Windows 桌面（默认不带）
```

开启后可以删掉手写的 `ip rule` / `conntrack mark`；这两层是等价手段，别同时上。

### 三个常见"优化"建议的实测结论

| 建议 | 结论 | 依据 |
|---|---|---|
| `default_domain_resolver` 改 `remote-dns` | **驳回** | `remote-dns` 是 `detour: proxies` 的 DoH。拿它解析**代理服务器自己的域名**会形成 bootstrap 死锁（解析要代理、代理要解析）。mihomo 为此专门有 `proxy-server-nameserver`。本配置的 39 个节点域名必须用本地/直连解析器 |
| `resolve` 全局改成只作用于 `rule_set: [cncidr, telegramcidr]` | **采纳意图，改用更正确的做法** | 给 `resolve` 加 `rule_set` 是无效的：`ip_cidr` 规则集在"还不知道目标 IP"时无法匹配，会永不触发。正确做法是把 **所有域名规则前置**，`resolve` 自然只对剩余连接生效（已在 `order.yaml` 落地） |
| `strict_route: true` 在 Windows 会挡局域网 | **证据不足，保留 true** | 1.14 文档里 Windows 下 `strict_route` 只声明三件事：不支持的网络不可达、阻止多网卡 DNS 泄露、非 TUN 接口的 53 端口被封；**没有**"挡局域网"的描述。如果你实测访问 NAS/打印机异常，把模板里 `strict_route` 改 `false` 即可 |

## 产物变体：规则集直连下载 vs 经代理下载

| 文件 | 规则集怎么下 | 适合 |
|---|---|---|
| `mihomo/config.yaml` / `singbox/template.json` | 直连 CDN | 默认；代理挂了也能启动 |
| `mihomo/config-proxy.yaml` / `singbox/template-proxy.json` | 经 `proxies` 组 | 直连 CDN 不通、节点确认可用 |

> 经代理下载的已知风险：sing-box 启动时 urltest 还没测速，会先用第一个成员；
> 若那一个节点是死的，17 个 rule-set 全部失败 → `FATAL`。用这个变体前请确认节点可用。

## 策略组

| 组（按显示顺序） | 成员顺序 | 默认 |
|---|---|---|
| `proxies` | 地区组 → 全部节点 → `DIRECT` | 第一个地区组 |
| `f1tv` | `美国` → 其他地区组 → `proxies` → `DIRECT` | `美国` |
| `direct` | `DIRECT` → 地区组 → `proxies` | `DIRECT` |
| `final` | `DIRECT` → `proxies` → 地区组 | `DIRECT`（未命中默认直连） |
| 地区组（排最后） | 该地区节点（url-test） | — |

- 地区组只保留常用 5 个：**香港 / 台湾 / 日本 / 美国 / 新加坡**（`config/regions.yaml`）。
  其余国家（阿根廷、澳大利亚、加拿大、法国、印度、俄罗斯、土耳其、乌克兰…）**不单独建组**，
  节点仍在 `proxies` 组里可手动选。
- 测速：`interval 300s`、`tolerance 500`；mihomo 额外 `lazy: true`（闲置不探测）。健康检查是 outbound
  内部连接，不经过路由规则，命中规则与否无影响。
- `config/node-filter.yaml` 的 `region_exclude_regex`（默认 `下载专用|x0\.01`）会把这类节点
  **只从地区组里剔除**，仍保留在 `proxies`，避免 url-test 选中它们承载日常流量。

### 两端全局差异（有意为之）

| 项 | mihomo | sing-box |
|---|---|---|
| 分流入口 | 系统代理 `mixed-port 7890` | `tun`（`10.66.0.1/30` + `fdfe:dcba:9876::1/126`）+ `mixed 7890` |
| DNS | `fake-ip` + DoH（223.5.5.5 / doh.pub），`proxy-server-nameserver` 走本地 DoH | `local-dns`/`remote-dns`(detour proxies) + `fakeip` |
| 域名恢复 | `sniffer`（TLS/HTTP/QUIC + `parse-pure-ip`） | `{"action":"sniff"}` |
| 控制 API | `127.0.0.1:9090`（不暴露局域网） | `127.0.0.1:9090` |

> tun 网段用 `10.66.0.1/30` 而不是官方的 `172.19.0.1/30`：Docker 默认地址池是 `172.17–172.31`，
> 服务器上跑 Docker 时 `172.19.x` 极易冲突。若你的服务器/局域网本身占用 `10.66.x`，改成别的 `/30`。

## 目录

```
config/regions.yaml     地区关键词表（组名/旗帜/关键词）—— 唯一真相
config/node-filter.yaml 信息节点排除正则（Sub-Store「正则筛选」用同一份）
rules/modules.yaml      模块定义：上游 / 自定义 / behavior
rules/order.yaml        规则顺序 + 目标组 —— 唯一真相
rules/custom/*.yaml     自建清单：airport google microsoft steam f1tv
templates/*.tpl         两端配置模板 + 3 个 Sub-Store 脚本模板
lib/grouping.mjs        纯函数：地区识别 + 四个组成员（两端共享）
build/*.mjs             抓取 / 解析 / 构建规则集 / 渲染 / 校验 / 冒烟
server/                 服务器运维资产：容器分流 / 拉配置 / 同步静态站点 / systemd 单元
                        （只影响本机部署，不影响规则语义与 CI 发布）
dist/                   产物（gitignore，CI 推 dist 分支）
```

## 本地构建

```bash
npm ci
npm test        # 70 个单测（node --test）
npm run build   # 生成 dist/（需要 sing-box 才能编 .srs）
npm run probe   # 冒烟：真跑 sing-box（本地 rule-set）+ mihomo -t（本机已装 mihomo）
npm run validate
```

`npm run build` 需要访问 `cdn.jsdelivr.net` 拉 clash-rules 文本；拉不到时用 `.cache/` 里上一份并告警。

### 两种基址（别混用）

| 用途 | 基址 | 谁在拉 |
|---|---|---|
| 模板与脚本（`mihomo/config.yaml`、`singbox/template.json`、`scripts/*.js`） | `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist` | Sub-Store 服务器（raw 缓存 5 分钟，改完即生效） |
| 规则集（`*/rules/*.list`、`*.srs`） | `https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist` | 客户端（jsDelivr 在国内可达；分支缓存 ≤12h） |

规则集没有改走 raw：那需要"用代理下载规则集"（mihomo `rule-providers.<名称>.proxy: proxies`、
sing-box `http_clients[].detour: proxies`），代价是**代理挂了规则集就下不到、客户端直接 FATAL**。
当前"直连 CDN"保证代理挂掉时客户端仍能启动。

## 服务器部署与运维

适用于「阿里云 Linux + sing-box（systemd，unit 自带 `User=sing-box`、`-C /etc/sing-box`、TUN `tun0`）
+ Docker 三网段 + nginx 容器」这套自建环境。脚本全部在 `server/`，只影响这台机器怎么跑，
**不改规则语义、也不改 CI 推 `dist` 的逻辑**。详细版见 `server/README.md`。

### 流量分层：宿主机 vs 容器

```
宿主机进程（curl / 客户端）──► 主表 default → tun0 ──► sing-box ──► 节点
                                        ▲
                            ip rule prio 100 → 表 2022
                                        │
Docker 容器（172.17/172.18/172.19）──► ip rule 判定
    ├─ prio 90  有 conntrack mark（DNAT 回程）→ 主表 → eth0   外部访问容器的回包
    ├─ prio 98  to 私网（10/8、172.16/12、192.168/16）→ 主表    容器访问局域网
    └─ prio 100 其余 → 表 2022 → tun0 → sing-box               容器出网走代理
```

数字越小越先匹配。表 `2022` 由 tun 的 `auto_route` 维护；`tun0` 不存在时脚本不加 prio 100，
改为 prio 8000（`lookup main` = 不接管）并告警 —— 容器只是「暂时不代理」，不会断网。

### `server/` 里有什么

| 文件 | 一行说明 |
|---|---|
| `docker-via-tun.sh` | `up`/`down` 幂等开关：容器网段接进 `tun0` + 给发布端口回程打 mark |
| `sbc-update.sh` | 每天从 Sub-Store 拉配置，四道闸（下载 / 形状 / 节点数≥5 / `sing-box check`）后原子替换并重启，内容没变不重启 |
| `sbc-sync-dist.sh` | 把 `dist` 分支（单 commit、强推）同步到 `/data/nginx/html/sbc` |
| `install.sh` | 幂等安装：脚本进 `/usr/local/bin`（700）、单元进 `/etc/systemd/system`、`enable --now` |
| `systemd/` | `docker-via-tun.service` + `sbc-update.{service,timer}`（05:00）+ `sbc-sync-dist.{service,timer}`（04:40，早于更新） |
| `nginx/sbc-static.conf` | `location /sbc/` 片段，贴进 `sub-store.yilabao.top` 的 443 server 块 |

### 安装三步

```bash
sudo ./server/install.sh                     # 1. 装脚本与单元，启用 1 service + 2 timer
                                             # 2. 贴 server/nginx/sbc-static.conf（location / 之前）
                                             #    然后 docker exec <nginx容器> nginx -t && … -s reload
sudo /usr/local/bin/sbc-sync-dist.sh         # 3. 手动跑一次两个脚本，确认输出 [OK]
sudo /usr/local/bin/sbc-update.sh
```

### 日常命令

| 想做的事 | 命令 |
|---|---|
| 手动刷新静态站点 | `sudo systemctl start sbc-sync-dist.service` |
| 手动重拉配置 | `sudo systemctl start sbc-update.service` |
| 看日志 | `journalctl -u sbc-update -u sbc-sync-dist -n 100` |
| 看下次触发 | `systemctl list-timers 'sbc-*'` |
| 回滚配置 | `sudo install -o root -g sing-box -m 640 /etc/sing-box/config.json.bak.<时间戳> /etc/sing-box/config.json && sudo systemctl restart sing-box` |
| 关/开容器分流 | `sudo systemctl stop docker-via-tun.service`（`restart` 恢复；`start` 对已 active 的 oneshot 是空操作） |

配置备份只保留最近 3 份，`ls -1t /etc/sing-box/config.json.bak.*` 可查。

### 自托管规则集

仓库变量 **`RULES_BASE_URL = https://sub-store.yilabao.top/sbc`**（CI 里作为 job 级 `BASE_URL`）：
构建出的 `rule_set.url` / `rule-provider.url` 全部指向自己域名，客户端不再依赖 jsDelivr。

- 依赖 `sbc-sync-dist.timer`（04:40）比 CI 的日构建（04:00 UTC）之后落地；push 后可手动 `systemctl start sbc-sync-dist.service`。
- 站点挂掉客户端仍能起：`.srs` 有 `cache_file` / `interval: 86400` 本地缓存；
  实在不行把 `RULES_BASE_URL` 改回 `https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist` 重跑 CI。
- 客户端如果觉得直连自己域名更快，可以让**模板**（`singbox/template.json`）用 `BASE_URL` 指向自己域名，
  而规则集继续走 CDN —— 两种基址的取舍见上一节。

### 故障模式

| 症状 | 原因 | 处理 |
|---|---|---|
| 域名解析成 `198.18.x` 却打不开网页 | **fakeip 必须配 tun**：只有 `mixed-in` 没有设备承载 fakeip 地址 | 保留 tun 入站；或不用 fakeip |
| 外部访问容器发布端口连上就断 | **容器进 tun 必须带 DNAT mark**：回程包被 prio 100 拉进 tun，从节点出口回去 | 确认 `iptables -t mangle -S PREROUTING` 有 `ctstate DNAT` mark、`ip rule show` 有 prio 90；或直接 `systemctl restart docker-via-tun.service` |
| 桌面端配置 `FATAL`：`auto_redirect is only supported on Linux` | **`auto_redirect` 仅 Linux**，写进共用模板会让 Windows 客户端整份配置失败 | 模板不带该字段，只在服务器链接上加 `&redirect=1`（见上文「让 Docker 容器也走代理」） |

## 加规则 / 改顺序

| 想做的事 | 改哪里 |
|---|---|
| 加一条自定义域名/进程规则 | `rules/custom/*.yaml`（`domain` / `domain_suffix` / `domain_keyword` / `domain_regex` / `ip_cidr` / `process_name`） |
| 换某个模块的数据源 | `rules/modules.yaml` 的 `sources` |
| 调整规则顺序或目标组 | `rules/order.yaml`（目标只允许 `reject` / `direct` / `proxies` / `f1tv`） |
| 加国家/地区组 | `config/regions.yaml` 加一行（有节点才生成） |
| 换客户端参数（端口/MTU/DNS） | `templates/mihomo.yaml.tpl` / `templates/singbox.json.tpl` |
| 改分组逻辑（默认项、成员顺序） | `lib/grouping.mjs`（两份脚本由它生成） |

改完 push 到 `main`，CI（push + 每日 04:00 UTC）会自动重建并更新 `dist` 分支。

---

## Sub-Store 配置（4 步）

> 前提：Node/Docker 版 Sub-Store，且设置环境变量 `SUB_STORE_FRONTEND_BACKEND_PATH=/`，
> 否则脚本无法执行。

### 1. 订阅（节点池）

新建「单条订阅」，名称 **`kitty`**（脚本按名称引用）：机场订阅 + UA `clash.meta/v1.19.99` + 超时 10000。

「节点操作」加三个自带算子（零脚本维护）：

| 顺序 | 算子 | 参数 |
|---|---|---|
| 1 | 正则筛选 Regex Filter | `keep` 关闭（丢弃命中），正则 `网址\|剩余\|流量\|重置\|套餐\|如遇\|永久\|官方\|群组\|欢迎\|官网\|频道\|个人\|到期\|续费\|免费` |
| 2 | 节点去重 Handle Duplicate | `delete`，字段 `name` + `server` + `port` |
| 3 | 节点排序 Sort | `asc` |

> 正则筛选默认 `keep: true`（只保留命中），留空正则会**把所有节点筛掉**。

### 2. 文件 `clash`（mihomo）

| 配置项 | 值 |
|---|---|
| 类型 | `mihomoConfig` |
| 来源 | 远程 `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/mihomo/config.yaml` |
| 处理 1 | 从订阅添加节点：`kitty`，位置 `replace` |
| 处理 2 | 脚本操作：`…/scripts/mihomo.js#name=kitty&noCache=true` |

### 3. 文件 `singbox`

| 配置项 | 值 |
|---|---|
| 类型 | 普通文件 |
| 来源 | 远程 `…/dist/singbox/template.json` |
| 处理 | 脚本操作：`…/scripts/singbox.js#name=kitty&noCache=true` |

### 4.（可选）Gist 同步

脚本不联网，一般不会超时；客户端若仍超时，把两个文件各建一个「同步」任务推到私有 Gist。

## 更换 / 新增订阅

三处引用必须指向同一个名字，否则两端节点集合不一致：

| 位置 | 字段 |
|---|---|
| 文件 `clash` →「从订阅添加节点」 | `sourceName` + `sourceType` |
| 文件 `clash` → 脚本 | `#name=<名字>` |
| 文件 `singbox` → 脚本 | `#name=<名字>&type=sub|col` |

- **A 原地换源**（最省事）：订阅名不变，只改远程 URL
- **B 新建订阅**：改上面三处指针
- **C 组合订阅**：新建 `air` 把多个订阅放进去，`clash` 的指针选「组合订阅」，
  `singbox` 脚本用 `#name=air&type=col&noCache=true`

## 缓存与生效时间

| 层 | 缓存 |
|---|---|
| GitHub raw（模板/脚本） | 5 分钟 |
| jsDelivr（规则集） | 分支缓存 ≤12h（规则每天更新，可接受） |
| Sub-Store 机场订阅 | 1 小时（前端刷新或 `?noCache=true`） |
| Sub-Store 远程脚本 | 1 小时 → 脚本 URL 已带 `#noCache=true`，已绕过 |
| Sub-Store 远程模板 | 1 小时 → 文件已设 `noCache: true`，已绕过 |
| mihomo rule-provider | `interval: 86400` |
| sing-box rule_set | `update_interval: 1d` + `cache_file` |

## 关闭 IPv6（默认开启）

- mihomo：`templates/mihomo.yaml.tpl` 里 `ipv6: true` → `false`
- sing-box：`dns.rules` 最前面加 `{ "query_type": ["AAAA"], "action": "reject" }`，
  `dns.strategy` 改 `ipv4_only`，删 tun 的 `fdfe:...` 地址与 fakeip 的 `inet6_range`

## 已知限制

- `PROCESS-NAME` / `process_name` 规则只在 Linux / Windows / macOS 生效
- mihomo `find-process-mode: strict` 才能命中进程规则（已默认开启）
- 本机没装 mihomo 时 `npm run probe` 会跳过 mihomo 那半（CI 里不会跳过）
- mihomo 的 rule-provider 用 `format: text`（一行一条），不再用 YAML `payload:`：
  实测 20 万条的 YAML 反序列化约 707ms，逐行切分约 26ms
- `dist` 只发布编译后的 `.srs`（`.json` 源码在编译成功后删除），分支体积约 9MB
