# sub-store-config

用 Sub-Store 一条链接下发**完整可跑的配置**（mihomo / sing-box 各一条），规则集自建、模块化、可 git 追溯。

- 节点：只来自你的机场订阅，Sub-Store 负责过滤/去重/排序
- 规则：本仓库生成，两端同源（`rules/order.yaml` + `rules/modules.yaml`）
- 分组：`proxies` / `direct` / `f1tv` / `final` + 按地区自动生成的节点组
- 产物：CI 每日构建，推送到 `dist` 分支，Sub-Store 直接 raw 引用

设计文档：`docs/superpowers/specs/2026-10-23-substore-config-design.md`
实施计划：`docs/superpowers/plans/2026-10-23-substore-config.md`

---

## 目录

```
config/regions.yaml     地区关键词表（组名/旗帜/关键词）—— 唯一真相
config/node-filter.yaml 信息节点排除正则（Sub-Store「丢弃筛选」用同一份）
rules/modules.yaml      模块定义：behavior + 上游来源 + 自定义条目
rules/order.yaml        规则顺序 + 目标组 —— 唯一真相
rules/custom/*.yaml     自定义规则（f1tv / steam / microsoft）
templates/*.tpl         两端配置模板与 Sub-Store 脚本模板
lib/grouping.mjs        纯函数：地区识别 + 四个组成员（两端共享）
build/*.mjs             构建与校验
dist/                   产物（CI 生成，推 dist 分支）
```

## 本地构建

```bash
npm ci
npm test        # 单元测试（node --test）
npm run build   # 生成 dist/
npm run validate
```

`npm run build` 需要能访问 `cdn.jsdelivr.net`；拉不到时用 `.cache/` 里上一份并在日志里告警。
`dist/` 已 gitignore——它由 CI 推送到 `dist` 分支（单 commit 强制覆盖）。

### 两种基址（重要，别混用）

| 用途 | 基址 | 谁在拉 | 为什么 |
|---|---|---|---|
| **模板与脚本**（`mihomo/config.yaml`、`singbox/template.json`、`scripts/*.js`） | `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist` | **Sub-Store 服务器** | 走 raw 只有 5 分钟缓存，改完立刻生效 |
| **规则集**（`*/rules/*.list`、`*.srs`） | `https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist` | **客户端**（mihomo / sing-box） | jsDelivr 在国内可达；分支缓存 ≤12h，规则每天更新，可接受 |

模板里已经写死了 jsDelivr 的规则集地址（构建时的 `BASE_URL`），所以 Sub-Store 那两个文件与三个脚本的 URL
都填 **raw** 版本即可。

> 踩过的坑：起初模板也走 jsDelivr，结果分支缓存导致客户端拿到 12 小时前的旧模板（缺字段 / 旧 URL），
> 而 jsDelivr 的 purge 接口有速率限制，刷不动。模板/脚本走 raw 就彻底没这个问题。

## 加规则 / 改顺序

| 想做的事 | 改哪里 |
|---|---|
| 加一条自定义域名/进程规则 | `rules/custom/*.yaml`（`domain` / `domain_suffix` / `domain_keyword` / `domain_regex` / `ip_cidr` / `process_name`） |
| 换某个模块的数据源 | `rules/modules.yaml` 的 `sources` |
| 调整规则顺序或目标组 | `rules/order.yaml`（目标只允许 `reject` / `direct` / `proxies` / `f1tv`） |
| 加国家/地区组 | `config/regions.yaml` 加一行（有节点才生成） |
| 换客户端参数（端口/MTU/DNS） | `templates/mihomo.yaml.tpl` / `templates/singbox.json.tpl` |
| 改分组逻辑（DIRECT 位置等） | `lib/grouping.mjs`（两份脚本由它生成） |

改完 push 到 `main`，CI 会自动重建并更新 `dist` 分支。

---

## Sub-Store 配置（4 步）

> 前提：Node/Docker 版 Sub-Store，且已设置环境变量
> `SUB_STORE_FRONTEND_BACKEND_PATH=/`（不想改路径就设 `/`），否则脚本无法执行。

### 1. 订阅（节点池）

新建「单条订阅」，名称 **`kitty`**（脚本按名称引用，改名要同步改脚本参数）：

| 配置项 | 值 |
|---|---|
| 远程订阅 | 你的机场订阅地址 |
| User-Agent | `clash.meta/v1.19.99`（按机场要求调整，优先 mihomo 订阅） |
| 超时 | `10000` |

「节点操作」只加 **一个脚本操作**（远程）：`https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/scripts/nodes.js`

它做三件事：剔除信息节点（正则来自 `config/node-filter.yaml`）、按 `name+server+port` 去重、按名称升序。
比在前端拼「丢弃筛选 / 去重 / 排序」更省事，也保证两个客户端拿到完全一样的节点集合。

### 2. 文件 `clash`（mihomo 用）

「文件」→ 新建：

| 配置项 | 值 |
|---|---|
| 类型 | `mihomoConfig`（mihomo 配置文件） |
| 来源 | 远程 |
| URL | `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/mihomo/config.yaml` |

「处理操作」按序添加：

1. **从订阅添加节点（Add Proxies）**：订阅 `kitty`，位置 `replace`
2. **脚本操作**：远程脚本 `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/scripts/mihomo.js#name=kitty`

保存后得到链接 `/api/file/clash`，直接导入 Mihomo Party / Clash Verge Rev 等。

### 3. 文件 `singbox`（sing-box 用）

| 配置项 | 值 |
|---|---|
| 类型 | 普通文件（file） |
| 来源 | 远程 |
| URL | `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/singbox/template.json` |

「处理操作」：**脚本操作** → 远程脚本 `https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/scripts/singbox.js#name=kitty`

保存后链接 `/api/file/singbox`。sing-box 内核本身没有订阅概念，用它的 GUI 或手动保存成
`config.json` 再 `sing-box run -c`。

### 4.（可选）同步到私有 Gist

脚本本身不发网络请求，正常不会超时；若客户端拉取仍超时，把上面两个文件各建一个「同步」任务，
定时推到私有 Gist，客户端改用 Gist 链接。

---

## 更换 / 新增订阅（机场）

三个地方引用订阅名，**必须指向同一个**，否则 mihomo 与 sing-box 会拿到不同的节点集合：

| 位置 | 字段 | 说明 |
|---|---|---|
| 文件 `clash` 的「从订阅添加节点」 | `sourceName` / `sourceType` | 决定 mihomo 拿谁的节点 |
| 文件 `clash` 的脚本操作 | `#name=<名字>` | 只在脚本里做展示/调试用，实际节点来自上一步 |
| 文件 `singbox` 的脚本操作 | `#name=<名字>&type=sub|col` | 决定 sing-box 拿谁的节点 |

### 方案 A：原地换源（最省事，推荐）

订阅名不变，只换 URL：订阅编辑页把远程订阅地址改成新的即可。
下游三个引用全部照旧，不用动。

### 方案 B：新建订阅，改指针

1. 新建订阅 `kitty2`
2. 文件 `clash` →「从订阅添加节点」：`sourceName` 改成 `kitty2`
3. 文件 `clash` 脚本：`…/scripts/mihomo.js#name=kitty2&noCache=true`
4. 文件 `singbox` 脚本：`…/scripts/singbox.js#name=kitty2&noCache=true`

### 方案 C：组合订阅（长期多机场）

1. 新建组合订阅 `air`，把 `kitty`、`kitty2`… 加进去
2. 文件 `clash` →「从订阅添加节点」：来源类型选 `collection`（组合订阅），名字填 `air`
3. 文件 `clash` 脚本：`#name=air&noCache=true`
4. 文件 `singbox` 脚本：`#name=air&type=col&noCache=true`（`type=col` 告诉脚本按组合订阅取）
5. 以后增删机场只改 `air`，两个文件都不用动

> 换机场后如果节点命名风格变了（比如没有旗帜、国家写成别的语言），地区组会变少或归错类——
> 在 `config/regions.yaml` 里补关键词即可，push 后自动生效。

## 分流行为

规则顺序（`rules/order.yaml`）先窄后宽：

```
category-ads-all → private → lancidr → f1tv → microsoft → apple → icloud → steam
→ applications → gfw → cncidr → telegramcidr → direct → proxy → (未命中) final
```

策略组：

| 组（按显示顺序） | 成员顺序 | 默认 |
|---|---|---|
| `proxies` | 地区组 → 全部节点 → `DIRECT` | 第一个地区组 |
| `f1tv` | `美国` → 其他地区组 → `proxies` → `DIRECT` | `美国` |
| `direct` | `DIRECT` → 地区组 → `proxies` | `DIRECT` |
| `final` | `DIRECT` → 地区组 → `proxies` | `DIRECT` |
| 地区组（有节点才生成，排在最后） | 该地区节点（urltest） | — |

`DIRECT` 位置规则：只有默认就是直连的 `direct` / `final` 把它放首位，其余放末位。

## 关闭 IPv6（默认开启）

- mihomo：`templates/mihomo.yaml.tpl` 里 `ipv6: true` → `false`
- sing-box：`templates/singbox.json.tpl` 的 `dns.rules` 最前面加一条
  `{ "query_type": ["AAAA"], "action": "reject" }`，并把 `dns.strategy` 改成 `ipv4_only`、
  删掉 tun 的 `fdfe:...` 地址、删掉 fakeip 的 `inet6_range`

## 已知限制

- sing-box 侧规则集在构建时用 `sing-box rule-set compile` 编成 `.srs`（合计约 3MB；
  同时保留 `.json` 便于 diff，模板只引用 `.srs`）。本机没有 sing-box 时自动退化为 source JSON
- `PROCESS-NAME` / `process_name` 规则只在 Linux / Windows / macOS 生效，移动端会失效
- 本机未安装 mihomo 时，CI/本地无法跑 `mihomo -t`，只做 YAML 结构校验
