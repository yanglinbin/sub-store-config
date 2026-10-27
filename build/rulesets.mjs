import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { parseClashText, normalizeCustom, dedupe, toHeadless, toMihomoPayload } from './parse.mjs';

/** behavior → 无类型纯值的默认 clash 类型（geoip 的 text/*.txt 是裸 CIDR） */
const DEFAULT_TYPE_OF = { domain: 'DOMAIN', ipcidr: 'IP-CIDR', classical: 'DOMAIN' };

/**
 * 合成单个模块的条目：上游 sources（按顺序）+ 自定义 custom，最后去重。
 * 返回 { name, behavior, entries }。
 */
export async function buildRuleSet(name, mod, { rootDir = process.cwd(), fetcher } = {}) {
  if (mod.kind === 'remote') {
    throw new Error(`module "${name}" 是 kind=remote，不应调用 buildRuleSet`);
  }
  if (mod.derive) {
    throw new Error(`module "${name}" 是 derive 模块，需要先构建其来源模块`);
  }
  const at = (p) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const defaultType = DEFAULT_TYPE_OF[mod.behavior];
  if (!defaultType) throw new Error(`module "${name}" 的 behavior 非法: ${mod.behavior}`);

  // 不用展开运算符：上游单文件可达 20 万条，push(...arr) 会爆栈
  const collected = [];
  const addAll = (entries) => {
    for (const entry of entries) collected.push(entry);
  };
  for (const url of mod.sources ?? []) {
    const text = await fetcher.get(url);
    addAll(parseClashText(text, { defaultType }));
  }
  if (mod.custom) {
    const obj = parse(readFileSync(at(mod.custom), 'utf8'));
    addAll(normalizeCustom(obj, mod.behavior));
  }
  return { name, behavior: mod.behavior, entries: dedupe(collected) };
}

/**
 * 按 order 顺序把每个模块写成两端产物：
 *   dist/singbox/rules/<name>.json  （source v3，一个字段一条 rule）
 *   dist/mihomo/rules/<name>.list   （clash 行）
 * 返回写出的相对路径数组。
 */
export async function writeRuleSets({
  modules,
  order,
  rootDir = process.cwd(),
  distDir = 'dist',
  fetcher,
}) {
  const dist = isAbsolute(distDir) ? distDir : resolve(rootDir, distDir);
  const jsonDir = join(dist, 'singbox/rules');
  const listDir = join(dist, 'mihomo/rules');
  // 先清掉上一次的产物，避免 order 删模块后留下孤儿文件
  rmSync(jsonDir, { recursive: true, force: true });
  rmSync(listDir, { recursive: true, force: true });
  mkdirSync(jsonDir, { recursive: true });
  mkdirSync(listDir, { recursive: true });

  const written = [];
  const done = new Set();

  // 第一趟：构建所有实体模块（sources / custom），derive 模块留到第二趟
  const built = new Map();
  for (const entry of order) {
    if (done.has(entry.module)) continue;
    done.add(entry.module);
    const mod = modules[entry.module];
    if (!mod) throw new Error(`order 引用了不存在的模块: ${entry.module}`);
    if (mod.kind === 'remote') continue; // IP 类直接引官方产物，不落盘
    if (mod.derive) continue;
    built.set(entry.module, await buildRuleSet(entry.module, mod, { rootDir, fetcher }));
  }

  // 第二趟：derive 模块从已构建的来源模块做集合运算
  for (const [name, mod] of Object.entries(modules)) {
    if (!mod.derive) continue;
    const [left, right] = mod.derive.intersect;
    const a = built.get(left);
    const b = built.get(right);
    if (!a) throw new Error(`derive 模块 "${name}" 的来源 "${left}" 没有构建产物（必须是本仓库的实体模块且在 order 中）`);
    if (!b) throw new Error(`derive 模块 "${name}" 的来源 "${right}" 没有构建产物（必须是本仓库的实体模块且在 order 中）`);
    const keyOf = (e) => `${e.type} ${e.value}`;
    const inRight = new Set(b.entries.map(keyOf));
    built.set(name, { name, behavior: mod.behavior, entries: a.entries.filter((e) => inRight.has(keyOf(e))) });
  }

  // 第三趟：按 order 写盘
  for (const entry of order) {
    if (alreadyWritten(entry.module, written)) continue;
    const mod = modules[entry.module];
    if (!mod) throw new Error(`order 引用了不存在的模块: ${entry.module}`);
    if (mod.kind === 'remote') continue; // IP 类直接引官方产物，不落盘
    const ruleSet = built.get(entry.module);
    if (!ruleSet) throw new Error(`模块 "${entry.module}" 没有构建产物`);
    const entries = ruleSet.entries;

    writeFileSync(join(jsonDir, `${entry.module}.json`), JSON.stringify(toHeadless(entries), null, 2) + '\n');

    // mihomo 用 format: text 读取：一行一条，无 YAML 包装。
    // 相比 yaml 格式，省掉几十万条带引号字符串的反序列化（实测解析耗时相差约 27 倍）
    const payload = toMihomoPayload(entries, mod.behavior);
    writeFileSync(join(listDir, `${entry.module}.list`), payload.join('\n') + '\n');
    written.push(`singbox/rules/${entry.module}.json`, `mihomo/rules/${entry.module}.list`);
  }
  return written;
}

/** 写盘去重（同一模块在 order 里只应出现一次，这里只是防御） */
function alreadyWritten(name, written) {
  return written.includes(`singbox/rules/${name}.json`);
}

/**
 * 按模块统计规则条目数：读 dist/mihomo/rules/<模块>.list 的有效行数。
 * kind=remote 的模块直接引用官方产物、本地不落盘，因此不会出现在结果里。
 */
export function countEntriesByModule(distDir = 'dist') {
  const dir = join(distDir, 'mihomo/rules');
  const byModule = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.list'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    byModule[file.slice(0, -'.list'.length)] = text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return byModule;
}

/** 统计规则条目总数：直接从 mihomo 的 text 产物按行数（编译成 .srs 后 json 会被删掉）。 */
export function countEntries(distDir = 'dist') {
  let total = 0;
  for (const n of Object.values(countEntriesByModule(distDir))) total += n;
  return total;
}
