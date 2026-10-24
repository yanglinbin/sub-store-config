# sub-store-config

用 Sub-Store 一条链接下发**完整可跑的配置**（mihomo / sing-box 各一条），规则集自建、模块化、可 git 追溯。

- 节点：只来自你的机场订阅，Sub-Store 负责过滤/去重/排序
- 规则：两端同源（`rules/order.yaml` + `rules/modules.yaml`）
  - **唯一上游：`Loyalsoldier/clash-rules`**（域名 + IP + 进程），CI 抓文本后转成两端产物
  - 自建清单 5 个：`airport`（机场入口直连）、`google`（全域走代理）、`microsoft`、`steam`、`f1tv`
  - 不引用 `geoip`、`meta-rules-dat`、`meta-rules-dat` 等其他仓库

### 规则顺序（16 个模块）

```
airport → category-ads-all(reject) → private → lancidr → f1tv
→ google(proxies) → microsoft → apple → icloud → steam → applications
→ gfw(proxies) → cncidr → telegramcidr(proxies) → direct → proxy(proxies)
→ final(默认 DIRECT)
```

两个刻意的位置安排：

- `airport` 放第一位：机场入口域名（`oh-node.com`）必须直连，否则"用代理连代理入口"会绕路
- `google` 放 `cncidr` 之前：`google.cn` / `googleapis.cn` / `gstatic.cn` 在大陆可直连，按 IP 会被判成直连；
  用户要求**这些 Google 域名一律走 `proxies`**

### 客户端参数

| 项 | mihomo | sing-box |
|---|---|---|
| 规则集来源 | `…@dist/mihomo/rules/*.list`（yaml） | `…@dist/singbox/rules/*.srs`（binary） |
| 下载走 | 直连 CDN（jsDelivr） | 直连 CDN（jsDelivr） |
| 策略组 | `proxies` / `f1tv` / `direct` / `final` + 动态地区组 | 同左 |
| IPv6 | 开启 | 开启（fakeip 含 v6 段） |

> 想改成"用代理拉 raw.githubusercontent.com"也是可行的（mihomo `rule-providers.<名称>.proxy: proxies`、
> sing-box `http_clients[].detour: proxies`），代价是**代理没起来时规则集下不到、启动报 FATAL**。
> 当前选择"直连 CDN"是为了让代理挂掉时客户端仍能启动。

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
| 加一个 IP 类规则 | `rules/modules.yaml` 加 `{kind: remote, upstream: geoip, behavior: ipcidr, category: <cn/hk/us/jp/netflix/google/…>}`，再在 `order.yaml` 加一行；本地不抓取不编译 |
| 调整规则顺序或目标组 | `rules/order.yaml`（目标只允许 `reject` / `direct` / `proxies` / `f1tv`） |
| 加国家/地区组 | `config/regions.yaml` 加一行（有节点才生成） |
| 换客户端参数（端口/MTU/DNS） | `templates/mihomo.yaml.tpl` / `templates/singbox.json.tpl` |
| 改分组逻辑（DIRECT 位置等） | `lib/grouping.mjs`（两份脚本由它生成） |


