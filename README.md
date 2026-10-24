# sub-store-config

用 Sub-Store 一条链接下发**完整可跑的配置**（mihomo / sing-box 各一条），规则集自建、模块化、可 git 追溯。

- 节点：只来自你的机场订阅，Sub-Store 负责过滤/去重/排序
- 规则：唯一上游 `Loyalsoldier/clash-rules`，两端同源（`rules/order.yaml` + `rules/modules.yaml`）
- 策略组：极简 `proxies` / `f1tv` / `direct` / `final` + 按地区自动生成的节点组
- 产物：CI 构建后推 `dist` 分支，Sub-Store 直接引用

设计文档：`docs/superpowers/specs/2026-10-23-substore-config-design.md`
实施计划：`docs/superpowers/plans/2026-10-23-substore-config.md`

---

## 规则集（14 个模块）

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
| 10 | `gfw` | clash-rules `gfw.txt` | domain | **proxies** |
| 11 | `cncidr` | clash-rules `cncidr.txt` | ipcidr | direct |
| 12 | `telegramcidr` | clash-rules `telegramcidr.txt` | ipcidr | **proxies** |
| 13 | `direct` | clash-rules `direct.txt` | domain | direct |
| 14 | `proxy` | clash-rules `proxy.txt` | domain | **proxies** |

未命中 → `final` 组。**两端都有兜底**：mihomo 末尾追加 `MATCH,final`，sing-box 用 `route.final: "final"`。

**Google 的走向**：`gfw` 列表里已含 251 条 Google/YouTube 域名（含 `google.cn`、`google.com`、`youtube.com`），
它在 `cncidr` 之前，所以 Google 流量走 `proxies`。**例外**：`googleapis.cn`、`gstatic.cn`、
`xn--ngstr-lra8j.com` 上游任何列表里都没有，会经 `cncidr` 判成直连——
想找回就在 `rules/custom/` 加一个 3 行的清单并挂回 `modules.yaml` / `order.yaml`。

sing-box 侧另有三个固定前置动作（不随 `order.yaml` 变化）：

```json
{"action":"sniff"},                              // 识别域名/协议
{"action":"hijack-dns","protocol":"dns"},        // 53 端口的 DNS 拉进 sing-box
{"action":"resolve","server":"local-dns"},       // 自动插在第一条 ipcidr 模块前
```

没有 `resolve` 时，fakeip 目标是 `198.18.x`，`cncidr` / `lancidr` / `telegramcidr` 永远不会命中。

## 策略组

| 组（按显示顺序） | 成员顺序 | 默认 |
|---|---|---|
| `proxies` | 地区组 → 全部节点 → `DIRECT` | 第一个地区组 |
| `f1tv` | `美国` → 其他地区组 → `proxies` → `DIRECT` | `美国` |
| `direct` | `DIRECT` → 地区组 → `proxies` | `DIRECT` |
| `final` | `proxies` → `DIRECT` → 地区组 | `proxies`（未命中默认走代理） |
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
dist/                   产物（gitignore，CI 推 dist 分支）
```

## 本地构建

```bash
npm ci
npm test        # 60 个单测（node --test）
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
