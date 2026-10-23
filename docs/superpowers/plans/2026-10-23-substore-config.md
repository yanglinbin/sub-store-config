# Sub-Store 双端配置与自建规则库 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建一个 GitHub 仓库，用一次 `npm run build` 从 Loyalsoldier 上游数据生成"自建模块化规则集 + 两个客户端完整模板 + 两份 Sub-Store 脚本"，让 Sub-Store 吐出 mihomo / sing-box 两条可直接跑的链接。

**Architecture:** 三份 YAML（`config/regions.yaml`、`rules/modules.yaml`、`rules/order.yaml`）是唯一真相，`build/` 下的无状态 Node 脚本把它们渲染成 `dist/` 产物（规则集 + 两端模板 + 两份注入式脚本），CI 把 `dist/` 推到 `dist` 分支供 raw 引用。Sub-Store 只做"模板 + 节点"的最后一跳。

**Tech Stack:** Node ≥ 20（ESM），唯一运行时依赖 `yaml@^2.7`，测试用内置 `node --test`，产物校验用 `sing-box 1.14.x`。

**Spec:** `docs/superpowers/specs/2026-10-23-substore-config-design.md`（施工前通读；本文档与 spec 冲突时以 spec 为准）

## Global Constraints

- Node ≥ 20，ESM（`"type": "module"`）；除 `yaml` 外不引入任何运行时依赖。
- 仓库根 = `E:/project/sub-store-config`；远端 `https://github.com/yanglinbin/sub-store-config`。
- 产物基址常量：`BASE_URL = "https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist"`。
- 组名固定为 `proxies` / `direct` / `f1tv` / `final`；地区组名 = `config/regions.yaml` 的 `name` 原样（中文）。
- 成员顺序规则（两端一致）：`direct`、`final` = `DIRECT` 在**首位**；`proxies` = 地区组 → 全部节点 → `DIRECT` **末位**；`f1tv` = `美国`（存在则首位，否则 `proxies`）→ 其他地区组 → `proxies` → `DIRECT` **末位**；地区组不含 `DIRECT`。
- 地区组动态：只生成"有节点"的地区；无节点地区不出现。
- IPv6 默认开启：sing-box `dns.strategy: "prefer_ipv4"`、无 AAAA reject、fakeip 含 `inet6_range`、tun 双栈；mihomo `ipv6: true`。
- sing-box 基准 1.14.x：必须显式 `http_clients` + `route.default_http_client`；禁止 `dns.independent_cache`；禁止 `download_detour`。
- Sub-Store 脚本（`dist/scripts/*.js`）不得访问网络、不得读写缓存、不得依赖时钟。
- 仓库不含任何密钥/订阅地址；`dist/` 由 CI 推送到 `dist` 分支（单 commit 强制推送）。
- 全部代码注释与文档用中文。

## Review Focus

1. **某地区零节点**：不生成该地区组，且 `proxies`/`f1tv` 成员不得为空（空组在 mihomo 与 sing-box 都是致命错误）——由 Task 7 的 `buildGroupDefs` 测试钉住。
2. **节点名同时命中多个地区**（如 `🇭🇰 Hong Kong 01 - 美国中转`）：只归入 `regions.yaml` 中**第一个**命中的地区，不重复计入——Task 7 `detectRegion` 测试。
3. **上游 txt 出现未知规则类型**（`SRC-IP`、`GEOIP` 等）：构建必须抛错，不得静默丢行——Task 2 测试。
4. **订阅产物为空**（机场挂掉）：脚本仍产出可启动配置（只剩 `direct` + `reject` 与四个空组兜底）——Task 7 脚本沙箱测试。
5. **节点名含 YAML/JSON 特殊字符**（emoji + 中文 + 冒号/逗号）：渲染出的 YAML 与 JSON 仍可被两端解析，组名与 tag 完全一致——Task 8 `sing-box check` 与 Task 9 的 `mihomo -t`（有则跑）。

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `config/regions.yaml` | 地区关键词表（唯一真相，注入两端） |
| `config/node-filter.yaml` | 信息节点排除正则（Sub-Store 管线用，README 引用） |
| `rules/modules.yaml` | 模块定义：behavior + 上游来源 + 自定义文件 |
| `rules/order.yaml` | 规则顺序 + 目标组 |
| `rules/custom/*.yaml` | 自定义条目（f1tv / steam / microsoft） |
| `build/load.mjs` | 读三份 YAML + 校验引用完整性 |
| `build/parse.mjs` | clash 文本 → Entry[] → headless / clash 行 |
| `build/fetch.mjs` | 上游抓取 + 磁盘缓存 |
| `build/rulesets.mjs` | 模块合成 → 规则集条目 |
| `build/render-mihomo.mjs` | 渲染 mihomo YAML |
| `build/render-singbox.mjs` | 渲染 sing-box JSON |
| `lib/grouping.mjs` | 纯函数：地区识别 + 四个组的成员计算（两端共享） |
| `build/emit-script.mjs` | 生成 `dist/scripts/{singbox,mihomo}.js` |
| `build/validate.mjs` | 语义 diff + `sing-box check` / `rule-set decompile` |
| `build/build.mjs` | CLI 入口，串起 4→8 |
| `tests/*.test.mjs` | 单元测试（`node --test`） |
| `dist/` | 产物（CI 生成，推 `dist` 分支） |

---

### Task 1: 仓库骨架 + 三份真相文件 + 加载校验

**Files:**
- Create: `package.json`, `.gitignore`, `README.md`（占位一节即可，Task 9 补全）
- Create: `config/regions.yaml`, `config/node-filter.yaml`, `rules/modules.yaml`, `rules/order.yaml`
- Create: `rules/custom/f1tv.yaml`, `rules/custom/steam.yaml`, `rules/custom/microsoft.yaml`
- Create: `build/load.mjs`
- Test: `tests/load.test.mjs`

**Interfaces:**
- Produces:
  - `loadRegions(path) -> Region[]`，`Region = { name: string, flag: string, keywords: string[] }`
  - `loadModules(path) -> Record<string, Module>`，`Module = { behavior: 'domain'|'ipcidr'|'classical', sources?: string[], custom?: string }`
  - `loadOrder(path, { modules }) -> OrderEntry[]`，`OrderEntry = { module: string, target: 'reject'|'direct'|'proxies'|'f1tv', no_resolve?: boolean }`
  - `loadAll(rootDir) -> { regions, modules, order }`（rootDir 默认 `process.cwd()`）
  - 校验失败一律 `throw new Error(...)`，消息含 `module`/`order` 字段名

- [ ] **Step 1: 初始化骨架**

```bash
cd E:/project/sub-store-config
git init -b main
npm init -y
npm install yaml@^2.7
```

`package.json` 改这三处：`"type": "module"`、`"scripts": { "build": "node build/build.mjs", "test": "node --test tests/", "validate": "node build/validate.mjs" }`、`"engines": { "node": ">=20" }`。

`.gitignore`：`node_modules/`、`.cache/`、`*.log`。

- [ ] **Step 2: 写 `config/regions.yaml`（逐字照抄）**

```yaml
# 地区关键词表：name 原样成为组名；keywords 大小写不敏感；flag 用于兜底识别
- { name: 香港, flag: "🇭🇰", keywords: [香港, hk, hongkong, "hong kong"] }
- { name: 台湾, flag: "🇹🇼", keywords: [台湾, 台灣, tw, taiwan] }
- { name: 日本, flag: "🇯🇵", keywords: [日本, jp, japan, tokyo] }
- { name: 美国, flag: "🇺🇸", keywords: [美国, 美國, us, usa, america, "united states"] }
- { name: 新加坡, flag: "🇸🇬", keywords: [新加坡, sg, singapore] }
- { name: 韩国, flag: "🇰🇷", keywords: [韩国, 韓國, kr, korea] }
- { name: 马来西亚, flag: "🇲🇾", keywords: [马来西亚, 馬來西亞, my, malaysia] }
- { name: 英国, flag: "🇬🇧", keywords: [英国, 英國, uk, "united kingdom", britain] }
- { name: 德国, flag: "🇩🇪", keywords: [德国, 德國, de, germany] }
- { name: 荷兰, flag: "🇳🇱", keywords: [荷兰, 荷蘭, nl, netherlands] }
```

- [ ] **Step 3: 写 `config/node-filter.yaml` 与 `rules/modules.yaml`（逐字照抄）**

```yaml
# 信息节点排除正则（Sub-Store 订阅层「丢弃筛选」用同一份）
exclude_regex: "网址|剩余|流量|重置|套餐|如遇|永久|官方|群组|欢迎|官网|频道|个人|到期|续费|免费"
```

```yaml
# 模块定义：sources 为上游文本（域名类→clash-rules，IP 类→geoip），custom 为本仓库自定义条目
category-ads-all:   # 即 Loyalsoldier 的 reject.txt（geosite:category-ads-all 的 clash 形态），纯上游，无 custom
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/reject.txt"]
gfw:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/gfw.txt"]
private:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/private.txt"]
lancidr:
  behavior: ipcidr
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/text/private.txt"]
f1tv:
  behavior: classical
  custom: rules/custom/f1tv.yaml
microsoft:      # 含 2 条 KEYWORD，故为 classical（见 ledger Ruling 3）
  behavior: classical
  custom: rules/custom/microsoft.yaml
apple:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/apple.txt"]
icloud:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/icloud.txt"]
steam:
  behavior: classical
  custom: rules/custom/steam.yaml
applications:
  behavior: classical
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/applications.txt"]
cncidr:
  behavior: ipcidr
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/text/cn.txt"]
telegramcidr:
  behavior: ipcidr
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/text/telegram.txt"]
direct:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/direct.txt"]
proxy:
  behavior: domain
  sources: ["https://cdn.jsdelivr.net/gh/Loyalsoldier/clash-rules@release/proxy.txt"]
```

- [ ] **Step 4: 写 `rules/order.yaml`（顺序即生效顺序）与四个自定义文件**

```yaml
- { module: category-ads-all, target: reject }
- { module: private,          target: direct }
- { module: lancidr,          target: direct, no_resolve: true }
- { module: f1tv,             target: f1tv }
- { module: microsoft,        target: direct }
- { module: apple,            target: direct }
- { module: icloud,           target: direct }
- { module: steam,            target: direct }
- { module: applications,     target: direct }
- { module: gfw,              target: proxies }
- { module: cncidr,           target: direct, no_resolve: true }
- { module: telegramcidr,     target: proxies }
- { module: direct,           target: direct }
- { module: proxy,            target: proxies }
```

`rules/custom/f1tv.yaml`：

```yaml
domain_suffix:
  - formula1.com
  - livetiming-proxy.multiviewer.dev
  - api.multiviewer.dev
process_name:
  - MultiViewer.exe
```

`rules/custom/steam.yaml`：`domain_suffix` 写 4 条（`steamcontent.com`、`api.steampowered.com`、`cm.steampowered.com`、`steamserver.net`），`ip_cidr` 写 **40 条**（旧文件实际条数，见 ledger Ruling 2），逐字照抄 `E:/project/clash-config-manager/config/rules.yaml` 里 "全球直连_steam下载" 段的 `IP-CIDR` 行（去掉 `,全球直连` 后缀）。

`rules/custom/microsoft.yaml`：源文件是 `payload:` + 2 条 `KEYWORD,`（→ `domain_keyword: [1drv, microsoft]`）+ 77 条 `+.domain`（→ `domain_suffix`，去掉 `+.`）。

- [ ] **Step 5: 写失败测试 `tests/load.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegions, loadModules, loadOrder, loadAll } from '../build/load.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ssc-'));

test('regions 解析出 10 个地区且字段齐全', () => {
  const regions = loadRegions('config/regions.yaml');
  assert.equal(regions.length, 10);
  assert.deepEqual(regions[0], { name: '香港', flag: '🇭🇰', keywords: ['香港', 'hk', 'hongkong', 'hong kong'] });
});

test('order 引用不存在的 module 时抛错并点名', () => {
  const d = tmp();
  writeFileSync(join(d, 'm.yaml'), 'a:\n  behavior: domain\n');
  writeFileSync(join(d, 'o.yaml'), '- { module: nope, target: direct }\n');
  assert.throws(() => loadOrder(join(d, 'o.yaml'), { modules: loadModules(join(d, 'm.yaml')) }), /nope/);
});

test('order 重复 module 抛错', () => {
  const d = tmp();
  writeFileSync(join(d, 'o.yaml'), '- { module: a, target: direct }\n- { module: a, target: proxies }\n');
  assert.throws(() => loadOrder(join(d, 'o.yaml'), { modules: { a: { behavior: 'domain' } } }), /重复/);
});

test('非法 behavior 抛错', () => {
  const d = tmp();
  writeFileSync(join(d, 'm.yaml'), 'a:\n  behavior: geoip\n');
  assert.throws(() => loadModules(join(d, 'm.yaml')), /behavior/);
});

test('loadAll 读通仓库真实配置', () => {
  const { regions, modules, order } = loadAll();
  assert.equal(order.length, 14);
  assert.equal(Object.keys(modules).length, 14);
  assert.ok(regions.every((r) => Array.isArray(r.keywords) && r.keywords.length > 0));
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，`Cannot find module '../build/load.mjs'`

- [ ] **Step 7: 实现 `build/load.mjs`**

用 `yaml` 的 `parse` 读文件；`loadRegions` 校验每项 `name/flag/keywords`；`loadModules` 校验 `behavior ∈ {domain,ipcidr,classical}`、`sources` 若存在必须是 `https://` 开头数组、`custom` 若存在则文件必须存在（`existsSync` 相对 `rootDir`）；`loadOrder(path, { modules })` 校验 module 存在、无重复、`target ∈ {reject,direct,proxies,f1tv}`；`loadAll(rootDir = process.cwd())` 返回三者并保证 `order` 里所有 module 都在 `modules` 中。

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test`
Expected: PASS（5 个用例）

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat: 仓库骨架与三份真相配置加载器"
```

---

### Task 2: clash 文本解析与双端序列化

**Files:**
- Create: `build/parse.mjs`
- Test: `tests/parse.test.mjs`

**Interfaces:**
- Produces:
  - `Entry = { type: 'DOMAIN'|'DOMAIN-SUFFIX'|'DOMAIN-KEYWORD'|'DOMAIN-REGEX'|'IP-CIDR'|'IP-CIDR6'|'PROCESS-NAME', value: string }`
  - `parseClashText(text) -> Entry[]`（兼容两种输入：纯行格式与 clash YAML payload 格式；忽略空行、`#` 注释、`payload:` 头；`- 'x'` / `- x` 去掉列表符与引号；`+.foo` 归一为 `DOMAIN-SUFFIX`；无逗号的纯值按 `mod.behavior` 解释为 `DOMAIN`/`IP-CIDR`，由调用方传 `{ defaultType }`；未知类型 `throw`）
  - `parseClashText(text, { defaultType = 'DOMAIN' })`
  - `normalizeCustom(obj, behavior) -> Entry[]`（对象形如 `{domain:[], domain_suffix:[], domain_keyword:[], ip_cidr:[], process_name:[]}`，按 behavior 校验）
  - `toHeadless(entries, version = 3) -> { version, rules: object[] }`（**一个字段一条 rule**，rules 之间是 OR）
  - `toMihomoLines(entries) -> string[]`（`DOMAIN-SUFFIX,x` 形式，保持原类型名）
  - `dedupe(entries) -> Entry[]`（按 `type + ' ' + value` 去重，保持首次出现顺序）

- [ ] **Step 1: 写失败测试 `tests/parse.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClashText, normalizeCustom, toHeadless, toMihomoLines, dedupe } from '../build/parse.mjs';

test('兼容 clash 的 YAML payload 格式（上游真实格式）', () => {
  const payload = ["payload:", "  - 'DOMAIN-SUFFIX,icloud.com'", '  - "DOMAIN,apple.com"', ''].join('\n');
  assert.deepEqual(parseClashText(payload), [
    { type: 'DOMAIN-SUFFIX', value: 'icloud.com' },
    { type: 'DOMAIN', value: 'apple.com' },
  ]);
  assert.deepEqual(parseClashText('payload:\n  - 1.1.1.0/24\n', { defaultType: 'IP-CIDR' }), [
    { type: 'IP-CIDR', value: '1.1.1.0/24' },
  ]);
});

test('六种类型逐条转换', () => {
  const text = [
    'DOMAIN,a.com', 'DOMAIN-SUFFIX,b.com', '+.c.com', 'DOMAIN-KEYWORD,kw',
    'IP-CIDR,1.2.3.0/24', 'IP-CIDR6,2001:db8::/32', 'PROCESS-NAME,foo.exe', '',
  ].join('\n');
  assert.deepEqual(parseClashText(text), [
    { type: 'DOMAIN', value: 'a.com' },
    { type: 'DOMAIN-SUFFIX', value: 'b.com' },
    { type: 'DOMAIN-SUFFIX', value: 'c.com' },
    { type: 'DOMAIN-KEYWORD', value: 'kw' },
    { type: 'IP-CIDR', value: '1.2.3.0/24' },
    { type: 'IP-CIDR6', value: '2001:db8::/32' },
    { type: 'PROCESS-NAME', value: 'foo.exe' },
  ]);
});

test('未知类型必须抛错而不是丢弃', () => {
  assert.throws(() => parseClashText('GEOIP,CN'), /GEOIP/);
});

test('headless 每个字段独立成一条 rule（AND/OR 语义）', () => {
  const out = toHeadless(parseClashText('DOMAIN,a.com\nDOMAIN,b.com\nIP-CIDR,1.2.3.0/24'));
  assert.deepEqual(out, {
    version: 3,
    rules: [{ domain: ['a.com', 'b.com'] }, { ip_cidr: ['1.2.3.0/24'] }],
  });
});

test('behavior=domain 里出现 ip_cidr 抛错', () => {
  assert.throws(() => normalizeCustom({ ip_cidr: ['1.1.1.1/32'] }, 'domain'), /ip_cidr/);
});

test('behavior=ipcidr 里出现 domain 抛错', () => {
  assert.throws(() => normalizeCustom({ domain: ['a.com'] }, 'ipcidr'), /domain/);
});

test('dedupe 保持顺序且去重', () => {
  const e = parseClashText('DOMAIN,a.com\nDOMAIN,a.com\nDOMAIN,b.com');
  assert.deepEqual(dedupe(e).map((x) => x.value), ['a.com', 'b.com']);
});

test('mihomo 行输出保持原类型', () => {
  assert.deepEqual(toMihomoLines(parseClashText('+.a.com\nIP-CIDR,1.1.1.0/24')), [
    'DOMAIN-SUFFIX,a.com', 'IP-CIDR,1.1.1.0/24',
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/parse.test.mjs`
Expected: FAIL，`Cannot find module '../build/parse.mjs'`

- [ ] **Step 3: 实现 `build/parse.mjs`**

要点：行分割兼容 `\r\n`；`type` 与 `value` 用首个逗号切分（值里可能含逗号时取剩余全部并 `trim`）；`+.'` 前缀映射为 `DOMAIN-SUFFIX`；
**`toHeadless` 必须一个字段一条 rule**（sing-box 的 headless rule：同一 rule 内不同字段是 **AND**，rules 之间是 **OR**；
全部字段塞进同一条会变成"既命中域名又命中 IP"，是错的）。字段输出顺序固定：
`domain`、`domain_suffix`、`domain_keyword`、`domain_regex`、`ip_cidr`、`process_name`；同一字段内的值保持首次出现顺序。
`normalizeCustom` 的 behavior 白名单：`domain` 只许 `domain/domain_suffix/domain_keyword/domain_regex`，
`ipcidr` 只许 `ip_cidr`，`classical` 全许。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/parse.test.mjs`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: clash 规则文本解析与双端序列化"
```

---

### Task 3: 上游抓取与磁盘缓存

**Files:**
- Create: `build/fetch.mjs`
- Test: `tests/fetch.test.mjs`

**Interfaces:**
- Produces: `createFetcher({ cacheDir, fetchImpl = globalThis.fetch, timeoutMs = 20000, onWarn = () => {} }) -> { get(url): Promise<string> }`
  - 缓存文件名 = `sha256(url).slice(0,16) + '.txt'`，内容为上游原文
  - `get` 行为（见 ledger Ruling）：**每次都尝试下载**（否则上游永不更新）；成功 → 写缓存 + 写内存 memo；失败且缓存存在 → `onWarn(url, err)` + 返回缓存；失败且无缓存 → `throw`。同一 fetcher 实例内重复 `get` 同一 URL 走 memo，不发第二个请求

- [ ] **Step 1: 写失败测试 `tests/fetch.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetcher } from '../build/fetch.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ssc-fetch-'));

test('首次下载并落盘，第二次走缓存不再请求', async () => {
  const cacheDir = dir();
  let calls = 0;
  const f = createFetcher({ cacheDir, fetchImpl: async () => { calls++; return { ok: true, text: async () => 'DOMAIN,a.com' }; } });
  assert.equal(await f.get('https://x/a.txt'), 'DOMAIN,a.com');
  assert.equal(await f.get('https://x/a.txt'), 'DOMAIN,a.com');
  assert.equal(calls, 1);
  assert.equal(readdirSync(cacheDir).length, 1);
});

test('下载失败但已有缓存时用缓存并告警', async () => {
  const cacheDir = dir();
  const warn = [];
  const ok = createFetcher({ cacheDir, fetchImpl: async () => ({ ok: true, text: async () => 'cached' }) });
  await ok.get('https://x/b.txt');
  const bad = createFetcher({ cacheDir, onWarn: (u, e) => warn.push(u), fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(await bad.get('https://x/b.txt'), 'cached');
  assert.equal(warn.length, 1);
});

test('下载失败且无缓存时抛错', async () => {
  const f = createFetcher({ cacheDir: dir(), fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(() => f.get('https://x/c.txt'), /boom/);
});

test('HTTP 非 2xx 视为失败', async () => {
  const f = createFetcher({ cacheDir: dir(), fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) });
  await assert.rejects(() => f.get('https://x/d.txt'), /404/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/fetch.test.mjs`
Expected: FAIL，`Cannot find module '../build/fetch.mjs'`

- [ ] **Step 3: 实现 `build/fetch.mjs`**

用 `node:crypto` 的 `createHash('sha256')`、`node:fs` 的 `mkdirSync(recursive)`/`readFileSync`/`writeFileSync`、`AbortSignal.timeout(timeoutMs)`。缓存目录默认 `.cache`，`createFetcher` 构造时确保目录存在。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/fetch.test.mjs`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 上游规则抓取与磁盘缓存"
```

---

### Task 4: 规则集组装与落盘

**Files:**
- Create: `build/rulesets.mjs`
- Modify: `build/build.mjs`（新建，先只做规则集阶段）
- Test: `tests/rulesets.test.mjs`

**Interfaces:**
- Consumes: `loadAll`（Task 1）、`parseClashText` / `normalizeCustom` / `dedupe` / `toHeadless` / `toMihomoLines`（Task 2）、`createFetcher`（Task 3）
- Produces:
  - `buildRuleSet(name, mod, { fetcher, rootDir }) -> Promise<{ name, behavior, entries }>`
  - `writeRuleSets({ modules, order, rootDir, distDir, fetcher }) -> Promise<string[]>`（返回写出文件相对路径数组）
    - sing-box：`dist/singbox/rules/<name>.json`（`toHeadless` 的 JSON，两空格缩进）
    - mihomo：`dist/mihomo/rules/<name>.list`（`toMihomoLines` 每行一条 + 末尾换行）
  - 只处理 `order` 里出现的模块（`order` 决定产物集合）

- [ ] **Step 1: 写失败测试 `tests/rulesets.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuleSet, writeRuleSets } from '../build/rulesets.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ssc-rs-'));
  mkdirSync(join(root, 'rules/custom'), { recursive: true });
  writeFileSync(join(root, 'rules/custom/c.yaml'), 'domain_suffix:\n  - custom.com\n');
  return root;
}
const fakeFetcher = (map) => ({ get: async (u) => { if (!(u in map)) throw new Error('no ' + u); return map[u]; } });

test('sources + custom 合并并去重', async () => {
  const root = fixture();
  const { entries } = await buildRuleSet('m', { behavior: 'domain', sources: ['https://x/a.txt'], custom: 'rules/custom/c.yaml' },
    { rootDir: root, fetcher: fakeFetcher({ 'https://x/a.txt': 'DOMAIN-SUFFIX,custom.com\nDOMAIN,a.com' }) });
  assert.deepEqual(entries.map((e) => `${e.type}:${e.value}`), ['DOMAIN-SUFFIX:custom.com', 'DOMAIN:a.com']);
});

test('domain 模块里 custom 写了 ip_cidr 直接失败', async () => {
  const root = fixture();
  writeFileSync(join(root, 'rules/custom/c.yaml'), 'ip_cidr:\n  - 1.1.1.1/32\n');
  await assert.rejects(() => buildRuleSet('m', { behavior: 'domain', custom: 'rules/custom/c.yaml' }, { rootDir: root, fetcher: fakeFetcher({}) }), /ip_cidr/);
});

test('writeRuleSets 只产出 order 里列出的模块', async () => {
  const root = fixture();
  const distDir = join(root, 'dist');
  const files = await writeRuleSets({
    rootDir: root, distDir,
    modules: {
      a: { behavior: 'domain', sources: ['https://x/a.txt'] },
      b: { behavior: 'ipcidr', sources: ['https://x/b.txt'] },
    },
    order: [{ module: 'a', target: 'direct' }],
    fetcher: fakeFetcher({ 'https://x/a.txt': 'DOMAIN,a.com', 'https://x/b.txt': 'IP-CIDR,1.1.1.0/24' }),
  });
  assert.deepEqual(files.sort(), ['mihomo/rules/a.list', 'singbox/rules/a.json']);
  assert.ok(existsSync(join(distDir, 'singbox/rules/a.json')));
  assert.equal(readFileSync(join(distDir, 'mihomo/rules/a.list'), 'utf8'), 'DOMAIN,a.com\n');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/rulesets.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `build/rulesets.mjs`**

`buildRuleSet`：依次 `fetcher.get` 每个 source → `parseClashText`；若 `mod.custom` 则读 YAML → `normalizeCustom(obj, mod.behavior)`；拼起来 `dedupe`。`writeRuleSets`：`mkdirSync(recursive)` 两个目录，按 `order` 顺序写出，同一模块只写一次（order 内模块本就唯一，由 Task 1 校验）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/rulesets.test.mjs`
Expected: PASS（3 个用例）

- [ ] **Step 5: 真实跑一次，确认上游可拉、条数合理**

Run:
```bash
node --input-type=module -e "
import { loadAll } from './build/load.mjs';
import { createFetcher } from './build/fetch.mjs';
import { writeRuleSets } from './build/rulesets.mjs';
const { modules, order } = loadAll();
const files = await writeRuleSets({ modules, order, rootDir: process.cwd(), distDir: 'dist', fetcher: createFetcher({ cacheDir: '.cache' }) });
console.log(files.length);
"
```
Expected: 输出 `28`（14 模块 × 2 端），`dist/singbox/rules/category-ads-all.json` 存在且 > 1MB，`dist/mihomo/rules/cncidr.list` 行数约 1 万。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 模块化规则集组装与双端落盘"
```

---

### Task 5: mihomo 模板渲染

**Files:**
- Create: `templates/mihomo.yaml.tpl`, `build/render-mihomo.mjs`
- Test: `tests/render-mihomo.test.mjs`

**Interfaces:**
- Consumes: `Region[]`、`OrderEntry[]`、`Record<string, Module>`（Task 1）
- Produces: `renderMihomo({ regions, order, modules, baseUrl }) -> string`（YAML 文本，`yaml.dump` 输出）
- 模板占位符：`{{RULE_PROVIDERS}}`、`{{RULES}}`、`{{PROXY_GROUPS_FALLBACK}}`（各自独占一行，缩进由渲染器给）
- 生成结构（值必须逐字一致）：
  - 顶层：`mixed-port: 7890`、`allow-lan: true`、`mode: rule`、`log-level: info`、`ipv6: true`、`external-controller: ":9090"`、`unified-delay: true`、`tcp-concurrent: true`、`find-process-mode: "strict"`（有进程规则，不能 off）、`profile: {store-selected: true, store-fake-ip: false}`、`proxies: []`
  - `rule-providers.<module>` = `{type: http, behavior: <behavior>, url: "<baseUrl>/mihomo/rules/<m>.list", path: "./ruleset/<m>.yaml", interval: 86400}`
  - `rules`：逐条 `RULE-SET,<module>,<target>`；`no_resolve` 为真时追加 `,no-resolve`；`target: reject` → `REJECT`，其余原样（`direct`/`proxies`/`f1tv`）
  - `proxy-groups`（fallback 骨架，仅保证无脚本时也能启动）：`{name: proxies, type: select, proxies: [DIRECT]}`、`{name: direct, type: select, proxies: [DIRECT]}`、`{name: f1tv, type: select, proxies: [DIRECT]}`、`{name: final, type: select, proxies: [DIRECT]}`

- [ ] **Step 1: 写失败测试 `tests/render-mihomo.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { loadAll } from '../build/load.mjs';
import { renderMihomo } from '../build/render-mihomo.mjs';

const BASE = 'https://base/dist';
const render = () => parse(renderMihomo({ ...loadAll(), baseUrl: BASE }));

test('全局字段与 spec 一致', () => {
  const c = render();
  assert.equal(c['mixed-port'], 7890);
  assert.equal(c['external-controller'], ':9090');
  assert.equal(c.ipv6, true);
  assert.equal(c['allow-lan'], true);
  assert.deepEqual(c.profile, { 'store-selected': true, 'store-fake-ip': false });
});

test('rule-providers 覆盖全部模块且 url 指向 dist', () => {
  const c = render();
  assert.equal(Object.keys(c['rule-providers']).length, 14);
  assert.equal(c['rule-providers']['category-ads-all'].url, `${BASE}/mihomo/rules/category-ads-all.list`);
  assert.equal(c['rule-providers']['category-ads-all'].behavior, 'domain');
  assert.equal(c['rule-providers'].cncidr.behavior, 'ipcidr');
  assert.equal(c['rule-providers'].f1tv.behavior, 'classical');
});

test('rules 顺序 = order.yaml 顺序，target 映射正确，no-resolve 生效', () => {
  const c = render();
  assert.deepEqual(c.rules, [
    'RULE-SET,category-ads-all,REJECT',
    'RULE-SET,private,direct',
    'RULE-SET,lancidr,direct,no-resolve',
    'RULE-SET,f1tv,f1tv',
    'RULE-SET,microsoft,direct',
    'RULE-SET,apple,direct',
    'RULE-SET,icloud,direct',
    'RULE-SET,steam,direct',
    'RULE-SET,applications,direct',
    'RULE-SET,gfw,proxies',
    'RULE-SET,cncidr,direct,no-resolve',
    'RULE-SET,telegramcidr,proxies',
    'RULE-SET,direct,direct',
    'RULE-SET,proxy,proxies',
  ]);
});

test('fallback 骨架包含四个组且非空', () => {
  const c = render();
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), ['proxies', 'direct', 'f1tv', 'final']);
  assert.ok(c['proxy-groups'].every((g) => g.proxies.length >= 1));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/render-mihomo.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `templates/mihomo.yaml.tpl` + `build/render-mihomo.mjs`**

模板写固定字段 + 三个占位行；渲染器负责生成 `rule-providers`（按 order 顺序插入对象，保证输出顺序稳定）、`rules` 数组、fallback `proxy-groups`，最后 `yaml.dump(..., { lineWidth: 0 })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/render-mihomo.test.mjs`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: mihomo 模板渲染"
```

---

### Task 6: sing-box 模板渲染

**Files:**
- Create: `templates/singbox.json.tpl`, `build/render-singbox.mjs`
- Test: `tests/render-singbox.test.mjs`

**Interfaces:**
- Produces: `renderSingbox({ regions, order, modules, baseUrl }) -> string`（JSON 文本，两空格缩进）
- 模板占位符：`"{{RULE_SET}}"`、`"{{RULES}}"`（字符串替换，替换后必须仍是合法 JSON）
- 必须生成的固定结构：
  - 顶层 `log: {level: "info", timestamp: true}`、`http_clients: [{tag: "direct-download", detour: "DIRECT"}]`（1.14 必须显式声明，否则用弃用的隐式默认客户端）
  - `dns.servers`：`{type: "https", tag: "local-dns", server: "223.5.5.5", path: "/dns-query"}`、`{type: "https", tag: "remote-dns", server: "1.1.1.1", path: "/dns-query", detour: "proxies"}`、`{type: "fakeip", tag: "fakeip", inet4_range: "198.18.0.0/15", inet6_range: "fc00::/18"}`
  - `dns.strategy: "prefer_ipv4"`、`dns.final: "remote-dns"`；**不得**出现 `AAAA` reject、不得出现 `independent_cache`
  - `inbounds[0]`：`{type: "tun", tag: "tun-in", address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"], auto_route: true, strict_route: true, stack: "mixed", mtu: 1400}`
  - `inbounds[1]`：`{type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 7890}`
  - `outbounds`：`[{type: "selector", tag: "proxies", outbounds: ["DIRECT"], default: "DIRECT"}, {type: "selector", tag: "direct", outbounds: ["DIRECT"]}, {type: "selector", tag: "f1tv", outbounds: ["DIRECT"]}, {type: "selector", tag: "final", outbounds: ["DIRECT"], default: "DIRECT"}, {type: "direct", tag: "DIRECT"}]`（脚本会覆盖这 4 个 selector）
    - **直连 outbound 的 tag 必须是 `DIRECT`**：sing-box 里 tag 全局唯一，组名 `direct` 与 outbound `direct` 会撞成 `duplicate outbound tag`。1.14 也已没有 `type: "reject"` outbound（拒绝走 `action: "reject"`）
  - `route`：`auto_detect_interface: true`、`default_http_client: "direct-download"`、`default_domain_resolver: "local-dns"`、`final: "final"`、`rule_set` 每条 `{type: "remote", tag, format: "binary", url: "<baseUrl>/singbox/rules/<m>.srs", update_interval: "1d"}`（按 order 顺序）
  - `experimental`：`cache_file: {enabled: true, store_fakeip: true}`、`clash_api: {external_controller: "127.0.0.1:9090"}`

- [ ] **Step 1: 写失败测试 `tests/render-singbox.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../build/load.mjs';
import { renderSingbox } from '../build/render-singbox.mjs';

const BASE = 'https://base/dist';
const render = () => JSON.parse(renderSingbox({ ...loadAll(), baseUrl: BASE }));

test('输出是合法 JSON 且顶层必备键齐全', () => {
  const c = render();
  for (const k of ['log', 'dns', 'inbounds', 'outbounds', 'route', 'experimental', 'http_clients']) assert.ok(k in c, k);
});

test('rule_set 按 order 顺序、url 指向 .srs、format=binary', () => {
  const c = render();
  assert.deepEqual(c.route.rule_set.map((r) => r.tag), loadAll().order.map((o) => o.module));
  assert.equal(c.route.rule_set[0].url, `${BASE}/singbox/rules/category-ads-all.srs`);
  assert.equal(c.route.rule_set[0].format, 'binary');
  assert.equal(c.route.rule_set[0].update_interval, '1d');
});

test('route 规则与 order 一致（reject 用 action=reject）', () => {
  const c = render();
  const routeRules = c.route.rules.filter((r) => r.rule_set);
  assert.equal(routeRules.length, 14);
  assert.deepEqual(routeRules[0], { rule_set: 'category-ads-all', action: 'reject' });
  assert.deepEqual(routeRules[1], { rule_set: 'private', action: 'route', outbound: 'direct' });
});

test('1.14 约束：显式 http client、无 independent_cache、无 AAAA reject', () => {
  const c = render();
  assert.equal(c.route.default_http_client, 'direct-download');
  assert.ok(Array.isArray(c.http_clients) && c.http_clients.length === 1);
  assert.ok(!('independent_cache' in c.dns));
  assert.ok(!JSON.stringify(c.dns).includes('AAAA'));
  assert.equal(c.dns.strategy, 'prefer_ipv4');
});

test('tun 双栈 + fakeip 含 v6 段 + final=final', () => {
  const c = render();
  assert.deepEqual(c.inbounds[0].address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126']);
  const fakeip = c.dns.servers.find((s) => s.type === 'fakeip');
  assert.equal(fakeip.inet6_range, 'fc00::/18');
  assert.equal(c.route.final, 'final');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/render-singbox.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `templates/singbox.json.tpl` + `build/render-singbox.mjs`**

模板内所有固定结构写死（含 `dns.rules`：`.lan/.local/.direct/.localhost` 与 NTP 关键词 → `local-dns`、`query_type: ["A","AAAA"] → fakeip`）；两个占位符由渲染器替换为 `JSON.stringify` 的片段（注意替换后整体再 `JSON.parse` 自检一次，失败即抛错）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/render-singbox.test.mjs`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: sing-box 模板渲染（1.14 约束）"
```

---

### Task 7: 分组算法 + 两份 Sub-Store 脚本

**Files:**
- Create: `lib/grouping.mjs`, `build/emit-script.mjs`, `templates/script-singbox.js.tpl`, `templates/script-mihomo.js.tpl`
- Test: `tests/grouping.test.mjs`, `tests/script.test.mjs`

**Interfaces:**
- Produces（`lib/grouping.mjs`，纯函数，零依赖）：
  - `detectRegion(name, regions) -> string | null`（大小写不敏感；`keywords` 与 `flag` 都试；多个命中时取 `regions` 中**第一个**）
  - `groupNodes(names, regions) -> { byRegion: Record<string, string[]>, unmatched: string[] }`（保持输入顺序）
  - `buildGroupDefs({ names, regions, style }) -> GroupDef[]`，`style ∈ {'singbox','mihomo'}`，`GroupDef = { name, type: 'select'|'urltest', members: string[], default?: string }`
  - 成员规则（必须逐条满足）：`direct` / `final` = `['DIRECT', ...地区组名, 'proxies']`，`default: 'DIRECT'`；`proxies` = `[...地区组名, ...全部节点名, 'DIRECT']`，`default: 首个地区组名 ?? 'direct'`；`f1tv` = `[('美国' 若存在), ...其他地区组名, 'proxies', 'DIRECT']`，`default: '美国' ?? 'proxies'`；地区组 = `{type:'urltest', members: byRegion[地区], url:'http://connectivitycheck.gstatic.com/generate_204', interval:60, tolerance:500}`；`DIRECT` 在 mihomo 侧写作 `DIRECT`、sing-box 侧写作 `direct`（由 `style` 决定）
  - 空集合兜底：`names` 为空时 `proxies.members = ['DIRECT'|'direct']`，不得出现空成员数组
- Produces（`build/emit-script.mjs`）：`emitScripts({ regionsPath, outDir }) -> Promise<string[]>`，生成 `dist/scripts/singbox.js` 与 `dist/scripts/mihomo.js`（把 `lib/grouping.mjs` 源码 + 地区表 JSON 内联进模板；产物内不得出现 `import`/`export`）

- [ ] **Step 1: 写失败测试 `tests/grouping.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRegion, groupNodes, buildGroupDefs } from '../lib/grouping.mjs';
import { loadRegions } from '../build/load.mjs';

const regions = loadRegions('config/regions.yaml');
const names = ['🇭🇰Hong Kong 03', '🇺🇸United States 01', '🇯🇵Japan 01', '🇭🇰 Hong Kong 01 - 美国中转', '未知节点'];

test('detectRegion 取第一个命中的地区', () => {
  assert.equal(detectRegion(names[0], regions), '香港');
  assert.equal(detectRegion(names[3], regions), '香港');
  assert.equal(detectRegion(names[4], regions), null);
});

test('groupNodes 保持顺序并分离未匹配节点', () => {
  const { byRegion, unmatched } = groupNodes(names, regions);
  assert.deepEqual(byRegion['香港'], ['🇭🇰Hong Kong 03', '🇭🇰 Hong Kong 01 - 美国中转']);
  assert.deepEqual(unmatched, ['未知节点']);
});

test('direct/final 的 DIRECT 在首位，proxies 的 DIRECT 在末位', () => {
  const defs = buildGroupDefs({ names, regions, style: 'singbox' });
  const get = (n) => defs.find((d) => d.name === n);
  assert.equal(get('direct').members[0], 'direct');
  assert.equal(get('final').members[0], 'direct');
  assert.equal(get('final').default, 'direct');
  assert.equal(get('proxies').members[0], '香港');
  assert.equal(get('proxies').members.at(-1), 'direct');
  assert.deepEqual(get('proxies').members.slice(0, 3), ['香港', '日本', '美国']);
  assert.equal(get('f1tv').members[0], '美国');
  assert.equal(get('f1tv').members.at(-1), 'DIRECT');
  assert.equal(get('f1tv').default, '美国');
  assert.ok(get('proxies').members.includes('未知节点'));
});

test('零节点不生成地区组，且 proxies 仍非空', () => {
  const defs = buildGroupDefs({ names: [], regions, style: 'mihomo' });
  assert.deepEqual(defs.map((d) => d.name), ['direct', 'f1tv', 'final', 'proxies']);
  assert.deepEqual(defs.find((d) => d.name === 'proxies').members, ['DIRECT']);
  assert.ok(defs.every((d) => d.members.length > 0));
});

test('两端都用 DIRECT 大写（sing-box 里 direct 组名与 outbound tag 不能同名）', () => {
  const defs = buildGroupDefs({ names, regions, style: 'mihomo' });
  assert.equal(defs.find((d) => d.name === 'final').members[0], 'DIRECT');
  assert.equal(defs.find((d) => d.name === 'proxies').members.at(-1), 'DIRECT');
});
```

- [ ] **Step 2: 写失败测试 `tests/script.test.mjs`（沙箱执行产物脚本）**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { emitScripts } from '../build/emit-script.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'ssc-scripts-'));
const template = JSON.stringify({
  inbounds: [], route: { rules: [], rule_set: [] }, experimental: {},
  outbounds: [
    { type: 'selector', tag: 'proxies', outbounds: ['direct'], default: 'direct' },
    { type: 'selector', tag: 'direct', outbounds: ['direct'] },
    { type: 'selector', tag: 'f1tv', outbounds: ['direct'] },
    { type: 'selector', tag: 'final', outbounds: ['direct'], default: 'direct' },
    { type: 'direct', tag: 'direct' },
    { type: 'reject', tag: 'reject' },
  ],
}, null, 2);

async function runSingbox(proxies) {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const ctx = {
    $arguments: { name: 'kitty' }, $files: [template],
    $content: null,
    produceArtifact: async () => proxies,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return JSON.parse(ctx.$content);
}

test('singbox 脚本注入节点、生成地区组与四个组', async () => {
  const cfg = await runSingbox([
    { type: 'vless', tag: '🇭🇰Hong Kong 03' },
    { type: 'vless', tag: '🇺🇸United States 01' },
  ]);
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  assert.equal(byTag['香港'].type, 'urltest');
  assert.deepEqual(byTag['香港'].outbounds, ['🇭🇰Hong Kong 03']);
  assert.deepEqual(byTag.proxies.outbounds.slice(0, 2), ['香港', '美国']);
  assert.equal(byTag.proxies.default, '香港');
  assert.equal(byTag.direct.outbounds[0], 'DIRECT');
  assert.ok(byTag.proxies.outbounds.includes('🇭🇰Hong Kong 03'));
  assert.equal(byTag.final.outbounds[0], 'DIRECT');
});

test('订阅为空时仍产出可启动配置', async () => {
  const cfg = await runSingbox([]);
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  for (const t of ['proxies', 'direct', 'f1tv', 'final']) {
    assert.ok(byTag[t].outbounds.length > 0, t);
  }
  assert.ok(cfg.outbounds.some((o) => o.type === 'direct' && o.tag === 'direct'));
});

test('mihomo 脚本按 config.proxies 重建 proxy-groups', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'mihomo.js'), 'utf8');
  const ctx = { $arguments: { name: 'kitty' }, console, config: null };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const out = ctx.main({ proxies: [{ name: '🇭🇰Hong Kong 03', type: 'ss' }], 'proxy-groups': [] });
  const byName = Object.fromEntries(out['proxy-groups'].map((g) => [g.name, g]));
  assert.equal(byName.final.proxies[0], 'DIRECT');
  assert.equal(byName.proxies.proxies.at(-1), 'DIRECT');
  assert.ok(byName.proxies.proxies.includes('🇭🇰Hong Kong 03'));
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test tests/grouping.test.mjs tests/script.test.mjs`
Expected: FAIL，模块/产物不存在

- [ ] **Step 4: 实现 `lib/grouping.mjs`**

`buildGroupDefs` 输出顺序固定为 `['direct','f1tv','final','proxies', ...地区组]`（测试依赖该顺序）。`detectRegion` 先按 `regions` 顺序逐个比 `flag` 是否包含在 `name`，再比 `keywords`（`name.toLowerCase().includes(kw.toLowerCase())`）。地区组顺序 = `regions.yaml` 中出现的顺序（测试断言 `香港,美国,日本`）。

- [ ] **Step 5: 实现 `templates/script-singbox.js.tpl` 与 `templates/script-mihomo.js.tpl` + `build/emit-script.mjs`**

sing-box 模板骨架（`__GROUPING_SRC__` / `__REGIONS_JSON__` 为注入点）：

```js
const REGIONS = __REGIONS_JSON__;
__GROUPING_SRC__

function operator(proxies) { return proxies; }

(async () => {
  const { name } = $arguments;
  const config = JSON.parse($files[0]);
  const nodes = await produceArtifact({ type: 'subscription', name, platform: 'sing-box', produceType: 'internal' });
  const tags = (nodes || []).filter((n) => n && n.tag);
  const defs = buildGroupDefs({ names: tags.map((n) => n.tag), regions: REGIONS, style: 'singbox' });
  const regionOutbounds = defs.filter((d) => d.type === 'urltest').map((d) => ({
    type: 'urltest', tag: d.name, outbounds: d.members,
    url: 'http://connectivitycheck.gstatic.com/generate_204', interval: '60s', tolerance: 500,
  }));
  const groupOutbounds = defs.filter((d) => d.type === 'select').map((d) => ({
    type: 'selector', tag: d.name, outbounds: d.members, ...(d.default ? { default: d.default } : {}),
  }));
  const staticTags = new Set(config.outbounds.map((o) => o.tag));
  config.outbounds = [
    ...tags.map((n) => n),
    ...regionOutbounds,
    ...groupOutbounds,
    ...config.outbounds.filter((o) => staticTags.has(o.tag) && !['proxies', 'direct', 'f1tv', 'final'].includes(o.tag)),
  ];
  $content = JSON.stringify(config, null, 2);
})();
```

mihomo 模板骨架：

```js
const REGIONS = __REGIONS_JSON__;
__GROUPING_SRC__

function main(config) {
  const names = (config.proxies || []).map((p) => p.name);
  const defs = buildGroupDefs({ names, regions: REGIONS, style: 'mihomo' });
  config['proxy-groups'] = defs.map((d) => ({
    name: d.name,
    type: d.type,
    proxies: d.members,
    ...(d.type === 'urltest'
      ? { url: 'http://connectivitycheck.gstatic.com/generate_204', interval: 60, tolerance: 500 }
      : {}),
  }));
  return config;
}
```

`emitScripts` 去掉 `lib/grouping.mjs` 里的 `export` 关键字后原样内联；产物断言：不含 `import ` / `export `（在测试里加 `assert.ok(!code.includes('export '))`）。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/grouping.test.mjs tests/script.test.mjs`
Expected: PASS（8 个用例）

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 两端共享分组算法与 Sub-Store 注入脚本"
```

---

### Task 8: 校验器 + 构建入口

**Files:**
- Create: `build/validate.mjs`, `build/build.mjs`
- Test: `tests/validate.test.mjs`

**Interfaces:**
- Produces:
  - `validateDist({ distDir = 'dist', baseUrl, skipBinaries = false }) -> Promise<{ ok: boolean, problems: string[] }>`，依次：
    1. 语义 diff：`dist/mihomo/config.yaml` 的 `rules` 与 `dist/singbox/template.json` 的 `route.rules` 是否指向同一模块序列与同一 target；
    2. 每个 `dist/singbox/rules/*.json` 用 `sing-box rule-set decompile` 校验（可用 `child_process.execFile`，失败即问题项）；
    3. 用假节点填充 sing-box 模板（`dist/singbox/template.json` 的 4 个 selector 成员替换为 `["direct"]`）后 `sing-box check` 通过。
  - `sing-box` 不存在时跳过 2/3 并在 `problems` 里给出 `skip: sing-box not found`（不算失败）
- Produces（`build/build.mjs`）：CLI，按 4→5→6→7→8 顺序跑，任何一步抛错则 `process.exitCode = 1`

- [ ] **Step 1: 写失败测试 `tests/validate.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { validateDist } from '../build/validate.mjs';

function makeDist(mihomoRules, singboxRules) {
  const d = mkdtempSync(join(tmpdir(), 'ssc-v-'));
  mkdirSync(join(d, 'mihomo'), { recursive: true });
  mkdirSync(join(d, 'singbox/rules'), { recursive: true });
  writeFileSync(join(d, 'mihomo/config.yaml'), stringify({ rules: mihomoRules, 'proxy-groups': [] }));
  writeFileSync(join(d, 'singbox/template.json'), JSON.stringify({ outbounds: [], dns: {}, route: { rules: singboxRules } }));
  return d;
}

test('两端模块序列不一致时报错', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'b', action: 'reject' }]);
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('不一致')));
});

test('两端一致时通过', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }]);
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/validate.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `build/validate.mjs` 与 `build/build.mjs`**

`validateDist` 的 `skipBinaries: true` 供单测使用；`validateDist` 中 `execFile('sing-box', ...)` 用 `{ cwd: distDir }`。`build/build.mjs` 的流程：`loadAll()` → `writeRuleSets` → `renderMihomo`/`renderSingbox` 写文件 → `emitScripts` → `validateDist`，并在 `dist/` 根写 `build-info.json`（`{builtAt, commit, counts: {modules, rules}}`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（全部用例）

- [ ] **Step 5: 全量构建 + 真机校验**

Run: `npm run build`
Expected: 退出码 0；`dist/singbox/template.json` 能过 `sing-box check`；`dist/mihomo/config.yaml` 用 `node -e "require('yaml').parse(...)"` 可解析（本机无 mihomo 时跳过 `mihomo -t`）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 语义 diff 与 sing-box 校验器，构建入口串联"
```

---

### Task 9: CI 与 dist 分支发布

**Files:**
- Create: `.github/workflows/build.yml`, `README.md`（补全）
- Test: 本地 dry-run + workflow 语法检查

**Interfaces:**
- Consumes: `npm run build`
- Produces: `dist` 分支上的产物（`mihomo/config.yaml`、`singbox/template.json`、`*/rules/*`、`scripts/*.js`）

- [ ] **Step 1: 写 `.github/workflows/build.yml`**

要求：`on: [push, schedule: '0 4 * * *', workflow_dispatch]`；`permissions: contents: write`；步骤 = checkout → setup-node 20 → `npm ci` → 安装 sing-box（`curl -fsSL https://github.com/SagerNet/sing-box/releases/download/v1.14.3/sing-box-1.14.3-linux-amd64.tar.gz | tar xz` 并加进 PATH）→ `npm run build` → 用 `git worktree`/`git subtree` 方式把 `dist/` 推到 `dist` 分支（`git push -f origin dist`，单 commit，`--author="github-actions"`）。

- [ ] **Step 2: 语法检查 workflow**

Run: `node -e "const yaml=require('yaml');const fs=require('fs');const w=yaml.parse(fs.readFileSync('.github/workflows/build.yml','utf8'));if(!w.jobs)throw new Error('no jobs');console.log(Object.keys(w.jobs))"`
Expected: 输出 `[ 'build' ]`

- [ ] **Step 3: 补全 `README.md`**

必须包含：仓库用途与目录说明；本地构建（`npm ci && npm run build`）；Sub-Store 配置四步（
① `SUB_STORE_FRONTEND_BACKEND_PATH=/`；② 建订阅 `kitty`（UA=mihomo、超时 10000、管线：丢弃筛选 `config/node-filter.yaml` 的正则 → 节点去重 → 去旗帜重加 → 按名排序）；③ 建文件 `clash`（type=mihomoConfig、sourceType=remote、url=`<BASE_URL>/mihomo/config.yaml`、处理=Add Proxies(kitty, replace) + 脚本操作 `<BASE_URL>/scripts/mihomo.js#name=kitty`）；④ 建文件 `singbox`（type=file、sourceType=remote、url=`<BASE_URL>/singbox/template.json`、处理=脚本操作 `<BASE_URL>/scripts/singbox.js#name=kitty`））；客户端导入两条 `/api/file/...` 链接；加规则/加地区的操作说明（改 `rules/custom/*.yaml` 或 `config/regions.yaml` 后 push）；关闭 IPv6 的手改方法。

- [ ] **Step 4: 本地 dry-run 全链路**

Run: `rm -rf dist .cache && npm ci && npm run build`
Expected: 退出码 0，`dist/` 下 4 类产物齐全，`dist/build-info.json` 的 `counts.modules === 14`。

- [ ] **Step 5: 提交并建远端**

```bash
git add -A
git commit -m "ci: 每日构建并发布到 dist 分支；补全部署手册"
git remote add origin https://github.com/yanglinbin/sub-store-config.git
git push -u origin main
```

- [ ] **Step 6: 等第一次 CI 跑完并核对 dist 分支**

在 GitHub Actions 页面确认成功；`curl -sI https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist/singbox/template.json` 返回 200。

---

### Task 10: 端到端验收（Sub-Store 实机）

**Files:**
- Modify: `README.md`（把实测结果/坑补进"已知问题"）
- Create: `docs/验收记录.md`

**Interfaces:**
- Consumes: Task 9 的 dist 分支 + 用户线上 Sub-Store

- [ ] **Step 1: 按 README 在 Sub-Store 里建订阅与两个文件**

核对：订阅 `kitty` 预览里信息节点已被过滤，节点数 > 0。

- [ ] **Step 2: 拉两条链接并本地校验**

```bash
curl -s "$CLASH_URL" -o /tmp/clash.yaml
curl -s "$SINGBOX_URL" -o /tmp/singbox.json
node -e "const y=require('yaml'),fs=require('fs');const c=y.parse(fs.readFileSync('/tmp/clash.yaml','utf8'));console.log(c['proxy-groups'].map(g=>g.name+':'+g.proxies.length))"
sing-box check -c /tmp/singbox.json
```
Expected: 组名含 `proxies/direct/f1tv/final` + 实际地区；`sing-box check` 无输出。

- [ ] **Step 3: 比对组内顺序与 spec**

对 `direct`/`final` 断言首项是 `DIRECT`/`direct`；对 `proxies`/`f1tv` 断言末项是 `DIRECT`/`direct`；`f1tv` 首项为 `美国`（若存在该地区）。

- [ ] **Step 4: 记录验收结果并提交**

写 `docs/验收记录.md`：日期、两条链接的组数与规则数、两端一致性结论、遗留问题（如 `mihomo -t` 未跑）。

```bash
git add -A && git commit -m "docs: 端到端验收记录"
```

---

## 自检

- **spec 覆盖**：§4.2 仓库布局 → Task 1/5/6/7/9；§4.3 三份 YAML → Task 1；§5 模块化规则 → Task 2/3/4；§6.1 分组与 DIRECT 位置 → Task 7；§6.2 规则顺序 → Task 1(order)/Task 5/6；§6.3/6.4 渲染 → Task 5/6；§6.5 一致性 → Task 8；§7 脚本契约 → Task 7；§8 构建发布 → Task 8/9；§9 失败安全 → Task 3(warn)/Task 2(未知类型抛错)；§10 验证 → Task 8/10；§11 环境 → Global Constraints；§13 三条确认 → Global Constraints。
- **未覆盖项**（实现时按 spec §12 决定）：`reject` 体积裁剪、Gist 同步、`SUB_STORE_PRODUCE_CRON`——都不进本计划，属可选增强。
