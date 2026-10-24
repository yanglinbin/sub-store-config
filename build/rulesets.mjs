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
  for (const entry of order) {
    if (done.has(entry.module)) continue;
    done.add(entry.module);
    const mod = modules[entry.module];
    if (!mod) throw new Error(`order 引用了不存在的模块: ${entry.module}`);
    if (mod.kind === 'remote') continue; // IP 类直接引官方产物，不落盘
    const { entries } = await buildRuleSet(entry.module, mod, { rootDir, fetcher });

    writeFileSync(join(jsonDir, `${entry.module}.json`), JSON.stringify(toHeadless(entries), null, 2) + '\n');

    // mihomo 用 format: text 读取：一行一条，无 YAML 包装。
    // 相比 yaml 格式，省掉几十万条带引号字符串的反序列化（实测解析耗时相差约 27 倍）
    const payload = toMihomoPayload(entries, mod.behavior);
    writeFileSync(join(listDir, `${entry.module}.list`), payload.join('\n') + '\n');
    written.push(`singbox/rules/${entry.module}.json`, `mihomo/rules/${entry.module}.list`);
  }
  return written;
}

/** 统计规则条目数：直接从 mihomo 的 text 产物按行数（编译成 .srs 后 json 会被删掉）。 */
export function countEntries(distDir = 'dist') {
  const dir = join(distDir, 'mihomo/rules');
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.list'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    total += text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return total;
}
