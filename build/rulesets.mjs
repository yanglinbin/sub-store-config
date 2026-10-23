import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  mkdirSync(jsonDir, { recursive: true });
  mkdirSync(listDir, { recursive: true });

  const written = [];
  const done = new Set();
  for (const entry of order) {
    if (done.has(entry.module)) continue;
    done.add(entry.module);
    const mod = modules[entry.module];
    if (!mod) throw new Error(`order 引用了不存在的模块: ${entry.module}`);
    const { entries } = await buildRuleSet(entry.module, mod, { rootDir, fetcher });

    writeFileSync(join(jsonDir, `${entry.module}.json`), JSON.stringify(toHeadless(entries), null, 2) + '\n');

    // mihomo 的 yaml rule-provider 必须是 { payload: [...] }；单引号转义成两个单引号
    const payload = toMihomoPayload(entries, mod.behavior);
    writeFileSync(
      join(listDir, `${entry.module}.list`),
      'payload:\n' +
        payload.map((line) => `  - '${String(line).replace(/'/g, "''")}'`).join('\n') +
        '\n',
    );
    written.push(`singbox/rules/${entry.module}.json`, `mihomo/rules/${entry.module}.list`);
  }
  return written;
}
