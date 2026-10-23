# 设计文档 v2：Sub-Store 双客户端配置 + 自建模块化规则库

日期：2026-10-23（v2，取代 v1）
状态：v2.1 定稿，等用户一句“开工”（批准后进入 writing-plans，之前不写实现代码）
作者：pi + 用户

v1 → v2 的变化：规则从"引用上游 srs"改为"**自建规则库**（模块化、可加自定义条目、CI 生成产物）"；
策略组大幅简化（`proxies` / `direct` / `f1tv` / `final` + 动态地区组）；mihomo 侧不再需要 JS。

---

## 1. 意图与动机

现状：`clash-config-manager` 是自建 Node 服务（Fastify + Web UI + Schema + git 轮询），
职责是"读订阅 → 生成 Clash 配置 → HTTP 下载"。

新方案：把配置生成搬进已部署的 Sub-Store（Docker 自建最新版）。Sub-Store 负责拉订阅、
按需处理节点、输出产物；**规则、分组、客户端参数**放在一个 GitHub 仓库里，用一次 CI
构建产出两个客户端的模板与规则集产物，Sub-Store 只做"模板 + 节点"的最后一跳。

目标：只维护一个仓库；改规则 = 改 YAML + CI 重建；两个客户端各一条链接，规则随链接下发；
不再需要自建服务。

## 2. 目标 / 非目标 / 反目标

**目标**

1. 自建**模块化规则库**：单一真相源（模块定义 + 规则顺序 + 自定义条目），一次构建同时产出
   mihomo 与 sing-box 两种格式；数据取自 Loyalsoldier 生态（`clash-rules` 文本 + `geoip` 的
   `text/*.txt`），`v2ray-rules-dat` 作为数据同源参照。
2. 自定义规则是**一等公民**：新增一条规则 = 在 `rules/custom/*.yaml` 加一行，CI 自动合并进产物。
3. 策略组只有四类：`proxies`（代理）、`direct`（直连）、`f1tv`（独立选择）、`final`（未命中，
   默认直连、可手选代理），外加**按国家/地区自动生成的节点组**。
4. 两条客户端链接（`/api/file/clash`、`/api/file/singbox`）直接可用，无需手工补规则。
5. 规则库产物可校验（sing-box 侧 `sing-box check` + 反编译；mihomo 侧 `mihomo -t`）。

**非目标**

- 不复刻 Web UI / Schema 校验 / 规则 lint / git 轮询。
- 不解析 `geosite.dat` / `geoip.dat`（protobuf 二进制）；域名数据统一用 `clash-rules` 的
  release 文本，IP 数据用 `Loyalsoldier/geoip@release/text/*.txt`。
- 不支持多机场轮换（用组合订阅即可，默认一条）。
- 不做节点测活/测速/落地检测。

**反目标（算失败）**

- 规则只能在前端点选修改（必须可 git 追溯、可 review）；
- 两个客户端规则集语义不一致（除 §6.5 明确列出的差异外）；
- 客户端每次刷新都要等几十秒（脚本无网络请求，规则集有 `update_interval` 缓存）。

## 3. 已验证的事实（全部来自源码 / 官方文档 / 实测 HTTP）

### 3.1 Sub-Store（本地克隆 2.43.1 + 官方文档）

| 事实 | 证据 |
|---|---|
| 订阅输出只有节点：mihomo 目标 = `proxies:` 单键；sing-box 目标 = `{outbounds, endpoints}` | `producers/utils.js:187`、`producers/sing-box.js:1700` |
| 「文件」是唯一能输出任意内容的产物（`$content` 可赋任意文本） | 文档 `file/overview`、`file/scripts` |
| `mihomoConfig` 类型文件：`sourceType=remote` + `url` = 整份配置模板；处理管线可再加工 | `test/restful/mihomo-config.spec.js:479-500` |
| Add Proxies（从订阅添加节点）是 mihomoConfig 专有操作，写进 `proxies` 字段 | 文档 `subscription/processors` |
| 远程脚本 `url#k=v` → `$arguments`；脚本内 `produceArtifact` 可读订阅产物 | 文档 `script/usage`、`script/api` |
| Node 版脚本必须设 `SUB_STORE_FRONTEND_BACKEND_PATH`（不改路径就设 `/`） | `core/proxy-utils/index.js:331` |
| 脚本耗时计入客户端拉取时间 → 用缓存 / 预热 / Gist 同步兜底 | 文档 `subscription/overview` |

### 3.2 sing-box 官方文档（v1.14.3，`SagerNet/sing-box@v1.14.3/docs/`）

| 事实 | 文档位置 |
|---|---|
| rule-set `format` 必填，但 `url/path` 以 `.json` / `.srs` 结尾时可省略（自动推断） | `configuration/rule-set/index.md` |
| `update_interval` 空则默认 `1d` | 同上 |
| 1.14 起 `download_detour` 弃用 → 用 `http_client`；**隐式默认 HTTP client 也弃用**（1.16 移除）→ 必须显式定义 `http_clients` + `route.default_http_client` | `rule-set/index.md`、`route/index.md` |
| source 格式 `{"version":3,"rules":[...]}`；`rule-set compile` 可转 `.srs` | `rule-set/source-format.md` |
| headless rule 支持 `domain` / `domain_suffix` / `domain_keyword` / `domain_regex` / `ip_cidr`(=`source_ip_cidr`) / `process_name` / `process_path` / `port` / `query_type` / `invert` / `type: logical` | `rule-set/headless-rule.md` |
| `process_name` 仅 Linux/Windows/macOS 有效 | 同上 |
| `route.find_process` 只在**没有**进程类规则时用于日志，有进程规则时无需开启 | `route/index.md` |
| DNS `reject` 默认 `method: default` = 回复 REFUSED（不是空应答） | `dns/rule_action.md` |
| `dns.strategy` 仍有效；**`dns.independent_cache` 于 1.14 弃用**（1.16 移除） | `dns/index.md` |
| fakeip 是 DNS server 类型（`type: fakeip`），字段 `inet4_range` / `inet6_range` | `dns/server/fakeip.md` |
| `selector` 有 `default` / `interrupt_exist_connections`；`urltest` 默认 `url=gstatic generate_204`、`interval=3m`、`tolerance=50`、`idle_timeout=30m` | `outbound/selector.md`、`outbound/urltest.md` |
| tun 支持 `address` / `auto_route` / `strict_route` / `stack` / `mtu`，1.14 新增 `platform.http_proxy` | `inbound/tun.md` |
| `http_client` 可为字符串（引用顶层 `http_clients` 的 tag）或对象（含 Dial Fields，故可 `detour: direct`） | `shared/http-client.md` |

### 3.3 上游数据源（实测字节数，2026-10-23）

`Loyalsoldier/clash-rules@release/*.txt`（= `v2ray-rules-dat` + `geoip` 的 Clash 形态导出）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `reject.txt` | 5,754,686 | 广告/跟踪 → REJECT |
| `direct.txt` | 2,285,398 | 国内域名 → direct |
| `proxy.txt` | 621,900 | 需代理域名 → proxies |
| `cncidr.txt` | 219,376 | CN IP → direct |
| `gfw.txt` | 94,987 | 需代理域名（**已启用**）→ proxies |
| `tld-not-cn.txt` | 11,820 | 备用，无需 |
| `apple.txt` | 5,424 | direct |
| `private.txt` | 3,543 | direct |
| `applications.txt` | 2,821 | 进程规则 → direct |
| `icloud.txt` | 1,141 | direct |
| `lancidr.txt` | 341 | 内网 IP → direct |
| `telegramcidr.txt` | 274 | → proxies |

`Loyalsoldier/geoip@release/text/*.txt`（纯 CIDR，比 clash-rules 的同名文件更"原料"）：
`cn.txt` 159,262、`private.txt` 355、`telegram.txt` 193。
`Loyalsoldier/v2ray-rules-dat@release/`：`geosite.dat` 11.4MB、`geoip.dat` 16.6MB（**不解析**，仅作溯源）。

## 4. 架构

### 4.1 数据流

```
GitHub 仓库 (源码)                    CI（cron + push）                Sub-Store                    客户端
rules/modules.yaml  ─┐
rules/order.yaml    ─┼─ build ──► dist 分支（产物） ──raw──► 文件 `clash` ──Add Proxies──►  /api/file/clash   mihomo
rules/custom/*.yaml ─┤             dist/mihomo/config.yaml        文件 `singbox` ──脚本操作──► /api/file/singbox  sing-box
config/regions.yaml ─┘             dist/mihomo/rules/*.list
templates/*.tpl     ─────────────► dist/singbox/template.json
                                   dist/singbox/rules/*.srs
                                   dist/scripts/singbox.js
                                             ▲
                       机场订阅 `kitty` ──────┘（produceArtifact，节点池）
```

### 4.2 仓库布局

```
sub-store-config/
├── config/
│   ├── regions.yaml         # 国家/地区关键词与旗帜（唯一真相，渲染进两端）
│   └── node-filter.yaml     # 信息节点排除正则（Sub-Store 管道与模板共用同一份）
├── rules/
│   ├── modules.yaml         # 模块定义：来源 URL / 附加自定义 / 输出行为(domain|ipcidr|classical)
│   ├── order.yaml           # 规则顺序 + 目标组（唯一真相）
│   └── custom/
│       ├── f1tv.yaml        # 域名 + PROCESS-NAME
│       ├── steam.yaml       # 域名 + IP-CIDR
│       └── microsoft.yaml   # 从旧仓库 clash_rules/Microsoft.txt 迁入
├── templates/
│   ├── mihomo.yaml.tpl      # 含 {{PROXY_GROUPS}} {{RULE_PROVIDERS}} {{RULES}} 插槽
│   └── singbox.json.tpl     # 含 {{RULE_SET}} {{RULES}} {{OUTBOUNDS}} {{DNS}} 插槽
├── build/
│   ├── fetch.mjs            # 下载上游 txt → .cache/（带 ETag/哈希，避免无谓重建）
│   ├── rulesets.mjs         # 归并模块 → dist 规则集（list / source json）
│   ├── compile-srs.mjs      # source json → .srs（调用本地/CI 的 sing-box）
│   ├── render.mjs           # 模板 + order + regions → dist 配置
│   └── validate.mjs         # sing-box check / rule-set decompile / mihomo -t（可选）
├── dist/                    # 产物（CI 生成，推送到 `dist` 分支，单 commit）
└── .github/workflows/build.yml
```

### 4.3 唯一真相（三份 YAML）

`config/regions.yaml`
```yaml
# name 会原样成为组名；keywords 命中节点名即归类；flag 用于兜底识别
- name: 香港
  flag: "🇭🇰"
  keywords: [香港, hk, hongkong, hong kong]
- name: 台湾
  flag: "🇹🇼"
  keywords: [台湾, tw, taiwan]
- name: 日本
  flag: "🇯🇵"
  keywords: [日本, jp, japan, tokyo]
- name: 美国
  flag: "🇺🇸"
  keywords: [美国, us, usa, united states, america]
- name: 新加坡
  flag: "🇸🇬"
  keywords: [新加坡, sg, singapore]
- name: 韩国
  flag: "🇰🇷"
  keywords: [韩国, kr, korea]
- name: 马来西亚
  flag: "🇲🇾"
  keywords: [马来西亚, my, malaysia]
- name: 英国
  flag: "🇬🇧"
  keywords: [英国, uk, united kingdom, britain]
- name: 德国
  flag: "🇩🇪"
  keywords: [德国, de, germany]
- name: 荷兰
  flag: "🇳🇱"
  keywords: [荷兰, nl, netherlands]
```

`rules/modules.yaml`（节选）——**域名类只能来自 clash-rules，IP 类全部来自 geoip 仓库**（见 §5）
```yaml
category-ads-all:            # 即 Loyalsoldier 的 reject.txt（geosite:category-ads-all 的 clash 形态），纯上游
  behavior: domain
  sources:
    - https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt
gfw:
  behavior: domain
  sources:
    - https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt
cncidr:
  behavior: ipcidr
  sources:
    - https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/text/cn.txt
lancidr:
  behavior: ipcidr
  sources:
    - https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/text/private.txt
applications:
  behavior: classical
  sources:
    - https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt
f1tv:
  behavior: classical
  custom: rules/custom/f1tv.yaml
```

`rules/order.yaml`（顺序即生效顺序）
```yaml
- { module: category-ads-all, target: reject }
- { module: private,          target: direct }
- { module: lancidr,          target: direct, no_resolve: true }
- { module: f1tv,             target: f1tv   }
- { module: microsoft,     target: direct  }
- { module: apple,         target: direct  }
- { module: icloud,        target: direct  }
- { module: steam,         target: direct  }
- { module: applications,  target: direct  }
- { module: gfw,           target: proxies }
- { module: cncidr,        target: direct, no_resolve: true }
- { module: telegramcidr,  target: proxies }
- { module: direct,        target: direct  }
- { module: proxy,         target: proxies }
```

### 4.4 Sub-Store 侧对象

| 对象 | 类型 | 配置 |
|---|---|---|
| 订阅 `kitty` | 单条订阅 | 机场 URL；UA=mihomo 订阅；超时 10000ms；处理管线：丢弃筛选（`config/node-filter.yaml` 的正则）→ 节点去重 → 去除重复旗帜 → 按名排序 |
| 文件 `clash` | `mihomoConfig` | sourceType=remote, url=`…/dist/mihomo/config.yaml`；处理：Add Proxies(kitty, position=replace) → 脚本操作 `…/dist/scripts/mihomo.js#name=kitty`（按 `config.proxies` 重建 proxy-groups，保证成员顺序与 sing-box 一致） |
| 文件 `singbox` | `file` | sourceType=remote, url=`…/dist/singbox/template.json`；处理：脚本操作 `…/dist/scripts/singbox.js#name=kitty` |
| 同步（可选） | — | 把两个文件产物同步到私有 Gist，给客户端更稳的链接 |

## 5. 规则库：模块化与自建

**分层**

1. **来源层**（`modules.yaml.sources`）：上游 txt，CI 拉取进 `.cache/`，按内容哈希去重。
2. **自定义层**（`modules.yaml.custom` 或 `rules/custom/*.yaml`）：`domain` / `domain_suffix` /
   `domain_keyword` / `ip_cidr` / `process_name` 五种原生写法。
3. **归并层**：`sources` + `custom` 去重、排序、按 `behavior` 校验（domain 模块里出现 `ip_cidr` 直接报错）。
4. **产物层**：
   - mihomo：`dist/mihomo/rules/<module>.list`（`payload:` 或纯列表，行为随模块）；
   - sing-box：`dist/singbox/rules/<module>.json`（source v3）→ 可选 `sing-box rule-set compile` 出 `.srs`。

**转换规则（txt → 结构）**
| clash 文本 | sing-box headless |
|---|---|
| `DOMAIN,x` | `domain: [x]` |
| `DOMAIN-SUFFIX,x` / `+.x` | `domain_suffix: [x]` |
| `DOMAIN-KEYWORD,x` | `domain_keyword: [x]` |
| `IP-CIDR,x` / `IP-CIDR6,x` | `ip_cidr: [x]` |
| `PROCESS-NAME,x` | `process_name: [x]` |
| 其它类型 | 构建失败并报错（不静默丢弃） |

**数据源分工（已尽力向 `geoip` 仓库靠拢，实测结论）**

| 类型 | 来源 | 说明 |
|---|---|---|
| IP 类（`cncidr` / `lancidr` / `telegramcidr`） | **`Loyalsoldier/geoip@release/text/*.txt`** | 该仓库的原料输出（`cn.txt` / `private.txt` / `telegram.txt`，均实测 200）；还提供各国 `text/<cc>.txt`，将来要加"某国 IP 直连"直接换 URL |
| 域名类（`category-ads-all` / `gfw` / `private` / `apple` / `icloud` / `direct` / `proxy` / `applications`） | `Loyalsoldier/clash-rules@release/*.txt` | **`geoip` 仓库不发布域名列表**（`text/reject.txt`、`clash/`、`geosite/` 全部 404），只能留在 clash-rules |
| `v2ray-rules-dat` | 不直接引用 | 只有 `geosite.dat`(11.4MB) / `geoip.dat`(16.6MB) protobuf；它是上述两个仓库的上游数据 |

结论：IP 类已全部迁到 `geoip` 仓库；域名类没有可迁移的去处（除非自己解 protobuf），故保留 `clash-rules`。

## 6. 分流规格

### 6.1 策略组（唯一真相：`templates/*.tpl` 由 `config/regions.yaml` 渲染）

| 组 | 类型 | 成员（顺序即默认优先级） |
|---|---|---|
| `proxies` | select | 全部地区组 → `全部节点` → `DIRECT`（**末位**） |
| `direct` | select | `DIRECT`（**首位**，本组默认项）→ 全部地区组 → `proxies` |
| `f1tv` | select | `美国`（美国组存在则首位，否则 `proxies`）→ 其他地区组 → `proxies` → `DIRECT`（**末位**） |
| `final` | select | `DIRECT`（**首位**，本组默认项）→ 全部地区组 → `proxies` |
| 各地区（动态，见下） | urltest | 该地区节点；**无节点则不生成该组** |

**DIRECT 位置规则**（用户已确认）：只有"默认就是直连"的组（`direct`、`final`）把 `DIRECT` 放**首位**（因为首位即默认选中项），
其余组（`proxies`、`f1tv`）一律把 `DIRECT` 放**末位**作兜底。地区组不含 `DIRECT`。

- 地区组**动态**："有什么国家生什么国家"。遍历节点名 + 旗帜命中 `config/regions.yaml`，只保留有节点的地区；
  未命中任何地区关键词的节点不会丢失——仍会出现在 `proxies` 组里。
- **两端成员顺序由同一个算法决定**（`lib/grouping.mjs`）：mihomo 侧不再用 `filter` / `include-all-proxies`
  （它们把节点插在不可控位置，无法保证 `DIRECT` 末位），而是由 Sub-Store 脚本读 `config.proxies`
  重建 `proxy-groups`；sing-box 侧由脚本按 tag 生成。两端因此逐组、逐项可比对。
- `f1tv` 的"默认美国"是策略：美国组存在则放第一位，否则退到第一个存在的地区组。
- 所有 select 组加 `interrupt_exist_connections`（sing-box）/ 不加（mihomo 无此语义）。

### 6.2 规则顺序（`order.yaml` 的渲染结果）

先窄后宽：广告拒绝 → 内网 → F1TV/应用/厂商白名单 → **GFW 域名（→proxies）** → 国内 IP → Telegram IP → 国内域名 → 兜底 `final`。

`gfw` 必须排在 `cncidr` **之前**：GFW 域名常被污染解析到国内 IP，若先走 `cncidr` 就会被误判直连。

与旧项目的**有意差异**（其余保持一致）：

| 项 | 旧 | 新 | 原因 |
|---|---|---|---|
| 广告拒绝的位置 | 在 `GEOIP,CN` 之后 | 最前 | 国内 IP 上的广告域名不该因为 IP 是 CN 就漏过去 |
| `RULE-SET,gfw` | 声明但未使用 | 启用，排在 `cncidr` 之前 → proxies | 补上遗漏；顺序理由见上 |
| `RULE-SET,reject` | 独立广告组 | 改名 `category-ads-all`（同源同数据），直接 reject | 对齐上游语义（geosite:category-ads-all），去掉自建 17 条腾讯域名（实测在 reject.txt 中已存在） |
| `GEOIP,CN` vs `proxy` 列表 | CN IP 在前 | 仍在前，但显式加了 `no_resolve` | 避免对纯 IP 规则做无谓解析 |
| 广告组 | 独立 select（REJECT/DIRECT） | 直接 `reject`，无组 | 用户要求只保留 4 类组 |
| 地区组 | 固定 5 个 | 按节点实际存在的地区动态生成 | "节点组使用国家地区分类" + 健壮性 |
| 未命中 | 漏网之鱼（默认 DIRECT） | `final`（默认 DIRECT，可选 proxies/地区组） | 需求明确 |

### 6.3 mihomo 渲染

- `rule-providers`：全部指向 `dist/mihomo/rules/<module>.list`（`type: http`, `behavior`, `interval: 86400`, `path: ./ruleset/<module>.yaml`）。
- `rules`：`RULE-SET,<module>,<target>`，`no_resolve: true` 的模块追加 `,no-resolve`。
- `proxy-groups`：**由 Sub-Store 脚本 `dist/scripts/mihomo.js` 重建**（读完 Add Proxies 注入的
  `config.proxies` 后覆盖 `proxy-groups`），算则见 §6.1；模板里的 `proxy-groups` 仅作为
  无脚本时的兑底骨架（含一组 `DIRECT`，保证单独拿模板也能启动）。
- 全局：`mixed-port: 7890`、`allow-lan: true`、`mode: rule`、`log-level: info`、`ipv6: true`（**默认开启 v6**）、
  `external-controller: :9090`、`unified-delay: true`、`tcp-concurrent: true`、
  `profile: {store-selected: true, store-fake-ip: false}`。
- 不加 `dns` 段（与旧项目一致）。IPv6 不做任何阻断，需要时由用户自己加 `ipv6: false`。

### 6.4 sing-box 渲染

- `rule_set`：`type: remote`、`url: …/dist/singbox/rules/<module>.srs`（扩展名推断 `format: binary`）、
  `update_interval: 1d`。**显式定义** `http_clients: [{tag: "direct", detour: "direct"}]` +
  `route.default_http_client: "direct"`（避开 1.14 的隐式默认弃用，也避免冷启动依赖代理）。
- DNS：`local`/`https` `223.5.5.5`、`https` `1.1.1.1`（`detour: proxies`）、`fakeip`；
  `strategy: prefer_ipv4`（**IPv6 默认开启**：不拦截 AAAA、不写 `ipv4_only`、fakeip 保留 `inet6_range`）；
  其余规则见模板插槽。**不使用** `independent_cache`（1.14 弃用）。
  需要关 v6 时手动加 `{query_type:["AAAA"], action:"reject"}` 即可，模板已预留位置注释。
- `inbounds`：`tun`（`address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"]` 双栈、`auto_route`、
  `strict_route`、`stack: mixed`、`mtu: 1400`）+ `mixed` 127.0.0.1:7890。
- `outbounds`：`{{OUTBOUNDS}}` 由脚本填（节点 + 地区 urltest + 4 个 select + `direct` + `reject`）。
- `route`：`auto_detect_interface`、`default_domain_resolver`、`final: "final"`、`rules` 见 §6.2。
- `experimental`：`cache_file`（`store_fakeip: true`）、`clash_api` 127.0.0.1:9090。

### 6.5 两端一致性检查

CI 里做一次"语义 diff"：把 `order.yaml` 提到目标组、再对两端渲染结果逐条比对模块序列，
不一致就 fail。这样两端不会因为手改模板而悄悄分叉。

## 7. 脚本契约（两端共享同一分组算法）

### 7.1 `dist/scripts/singbox.js`

输入：`$arguments = { name }`；`$files[0]` = 模板 JSON。
1. `JSON.parse($files[0])`；
2. `produceArtifact({type:'subscription', name, platform:'sing-box', produceType:'internal'})` 取节点；
3. 按 `regions.yaml` 关键词归类（脚本内内联该表——由构建脚本从 YAML 注入，避免手抄）；
4. 生成地区 `urltest` 组（仅有节点的地区），生成 `proxies` / `direct` / `f1tv` / `final` 四个 selector；
5. 空组兜底：`outbounds` 里至少保留 `direct`；任何 selector 的成员为空则回退到 `direct`；
6. `$content = JSON.stringify(config, null, 2)`。

### 7.2 `dist/scripts/mihomo.js`

输入：`$arguments = { name }`；`main(config)` 收到 Add Proxies 已注入节点后的完整 YAML 对象。
1. 从 `config.proxies` 取节点名（不重新拉订阅）；
2. 用与 7.1 **同一份** `lib/grouping.mjs` 计算地区划分与四个组；
3. 覆盖 `config['proxy-groups']`；空组兑底为 `[DIRECT]`；
4. `return config`。

约束（两端）：不访问网络、不写缓存、不依赖时钟；预计执行 < 100ms。
两边脚本均由 `build/emit-script.mjs` 把 `lib/grouping.mjs` + 地区表拼接成单文件产物。

## 8. 构建、发布、体积

- CI 触发：`push`（改 rules/templates/config）+ 每日 cron（拉上游更新）。
- 产物落地在 **`dist` 分支**（单 commit 强制推送，避免主仓库历史膨胀）；`raw.githubusercontent.com/…/dist/…` 作为 Sub-Store 引用地址。
- 体积预估（首次拉取）：mihomo 规则集合计 ~9MB（`reject` 5.7MB 占大头）；sing-box `.srs` 合计 ~3MB。
  两者都有 `interval`/`update_interval` 缓存。若嫌大：`reject` 模块可裁剪（`modules.yaml` 里加
  `max_entries` 或换 `Loyalsoldier/geoip` 的细分列表）——列入 §12。
- 构建失败策略：`dist` 分支不更新（Sub-Store 继续拿到上一份可用产物），CI 标记失败。

## 9. 失败与安全

- 上游拉取失败：用 `.cache/` 里上一份 + 记录告警；无缓存则跳过、不推送 dist。
- 模块里出现不支持的行：构建失败（不静默丢弃），避免"规则悄悄少一条"。
- 机场信息节点：订阅层丢弃筛选 + 模板 filter 双保险。
- 仓库不含任何密钥；订阅 URL 只在 Sub-Store 里；Gist 一律私有。
- 脚本超时：无网络请求；仍保留 Gist 同步作为可选兜底。

## 10. 验证方式

1. `sing-box check -c dist/singbox/template.json`（用假节点填充后）；
2. `sing-box rule-set decompile dist/singbox/rules/*.srs` 全部成功，条目数与源 txt 对齐；
3. `mihomo -t -f dist/mihomo/config.yaml`（CI 可选，本地必须）；
4. 语义 diff：`order.yaml` ↔ 两端渲染结果（§6.5）；
5. 人工：Sub-Store 预览两条链接，核对组员/规则条数；与旧 `output/clash_profile.yaml` 抽查 10 条规则行为。

## 11. 已确认的环境约束

| 项 | 结论 | 影响 |
|---|---|---|
| Sub-Store | Docker 自建，最新版（非 Workers） | `mihomoConfig`+Add Proxies 可用；须设 `SUB_STORE_FRONTEND_BACKEND_PATH`；cron/Gist 可用 |
| 客户端 | mihomo 与 sing-box **不同机器** | 端口都用 7890/9090，无需错开 |
| sing-box 平台 | Windows 桌面（1.14.3 本机已装） | `process_name` 可用；TUN 参数可沿用现有值 |

## 12. 留给实现者的决定

- 是否对 `reject` 模块做裁剪（体积 5.7MB → ?）；
- `.srs` 编译是否进 CI（推荐进；本地缺 sing-box 时退化为 source json）；
- `dist` 分支 vs 主仓库 `dist/` 目录（默认前者）；
- `f1tv` 默认地区固定美国（美国组存在则首位，否则 `proxies`）；
- 是否开启 Gist 同步与 `SUB_STORE_PRODUCE_CRON`（默认都不开）。

## 13. 已确认的决定（本轮定稿）

1. **地区组动态生成**：节点里有什么国家就有什么地区组，不再固定 5 个；`regions.yaml` 是可扩展的关键词表。
2. **组内顺序与 DIRECT 位置**：`direct` / `final` 的 `DIRECT` 在首位（即默认选中项）；
   `proxies` / `f1tv` 的 `DIRECT` 在末位；`f1tv` 首位固定美国。地区组不含 `DIRECT`。
3. **IPv6 默认开启**：不拦 AAAA、`strategy: prefer_ipv4`、fakeip 保留 v6 段、tun 双栈；
   需要关闭时由用户手改（模板预留注释位置）。这与之前 `kitty.lyc.json` 里"禁用 IPv6"的实验产物**不一致**，
   新产物以本节为准。
