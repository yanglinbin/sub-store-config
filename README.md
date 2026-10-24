# sub-store-config

用 Sub-Store 一条链接下发**完整可跑的配置**（mihomo / sing-box 各一条），规则集自建、模块化、可 git 追溯。

- 节点：只来自你的机场订阅，Sub-Store 负责过滤/去重/排序
- 规则：两端同源（`rules/order.yaml` + `rules/modules.yaml`）
  - **当前处于重构中：只引用 `Loyalsoldier/geoip` 一个上游**（IP 类，直引官方 `srs` / `mrs`）
  - **自建规则集只留 `f1tv`** 一个（其余自定义清单已删除，git 历史里可找回）
  - 不引用 `clash-rules`、`meta-rules-dat` 或任何其他仓库

> ⚠️ 重构中的行为提醒：现在只有 **4 条规则**（`geoip-private` / `f1tv` / `geoip-cn` / `geoip-telegram`），
> 全是 IP 维度。也就是说：
> - 广告域名**不会被拦截**（没有 reject 规则）
> - 非中国域名**不会因为域名规则走代理**——只有 Telegram 的 IP 段会走 `proxies`
> - 其余流量落到 `final`（默认 `DIRECT`），想临时全走代理就在客户端点 `proxies` 组
>
> 规则规划好之后，在 `modules.yaml` / `order.yaml` 加模块即可，模板与脚本不用动。

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


