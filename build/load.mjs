import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';

const BEHAVIORS = new Set(['domain', 'ipcidr', 'classical']);
const KINDS = new Set(['built', 'remote']);
const UPSTREAMS = new Set(['geoip']);
const TARGETS = new Set(['reject', 'direct', 'proxies', 'f1tv']);

function readYaml(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`YAML 解析失败 (${path}): ${err.message}`);
  }
}

/** 读取地区关键词表；name 原样成为组名。 */
export function loadRegions(path) {
  const raw = readYaml(path);
  if (!Array.isArray(raw)) throw new Error(`regions 必须是数组: ${path}`);
  return raw.map((item, i) => {
    if (!item || typeof item.name !== 'string' || item.name.trim() === '') {
      throw new Error(`regions[${i}].name 缺失或为空`);
    }
    if (typeof item.flag !== 'string' || item.flag === '') {
      throw new Error(`regions[${i}].flag 缺失（${item.name}）`);
    }
    if (
      !Array.isArray(item.keywords) ||
      item.keywords.length === 0 ||
      item.keywords.some((k) => typeof k !== 'string' || k === '')
    ) {
      throw new Error(`regions[${i}].keywords 必须是非空字符串数组（${item.name}）`);
    }
    return { name: item.name, flag: item.flag, keywords: [...item.keywords] };
  });
}

/** 读取模块定义；behavior 决定产物形态。 */
export function loadModules(path) {
  const raw = readYaml(path);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`modules 必须是对象映射: ${path}`);
  }
  const modules = {};
  for (const [name, def] of Object.entries(raw)) {
    if (!def || typeof def !== 'object') throw new Error(`module "${name}" 定义非法`);
    const kind = def.kind ?? 'built';
    if (!KINDS.has(kind)) throw new Error(`module "${name}" 的 kind 非法: ${def.kind}（只允许 built/remote）`);
    if (kind === 'remote') {
      if (!UPSTREAMS.has(def.upstream)) {
        throw new Error(`module "${name}" 的 upstream 非法: ${def.upstream}（目前只允许 geoip）`);
      }
      if (typeof def.category !== 'string' || def.category === '') {
        throw new Error(`module "${name}" 是 remote，必须给 category（上游文件名）`);
      }
      if (!BEHAVIORS.has(def.behavior)) {
        throw new Error(`module "${name}" 的 behavior 非法: ${def.behavior}`);
      }
      modules[name] = {
        kind,
        upstream: def.upstream,
        behavior: def.behavior,
        category: def.category,
      };
      continue;
    }
    if (!BEHAVIORS.has(def.behavior)) {
      throw new Error(`module "${name}" 的 behavior 非法: ${def.behavior}（只允许 domain/ipcidr/classical）`);
    }
    if (def.sources !== undefined) {
      if (
        !Array.isArray(def.sources) ||
        def.sources.length === 0 ||
        def.sources.some((u) => typeof u !== 'string' || !u.startsWith('https://'))
      ) {
        throw new Error(`module "${name}" 的 sources 必须是 https:// 字符串数组`);
      }
    }
    if (def.custom !== undefined && (typeof def.custom !== 'string' || def.custom === '')) {
      throw new Error(`module "${name}" 的 custom 必须是文件路径字符串`);
    }
    if (def.derive !== undefined) {
      if (def.sources || def.custom) {
        throw new Error(`module "${name}" 的 derive 不能与 sources/custom 同时使用`);
      }
      const d = def.derive;
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        throw new Error(`module "${name}" 的 derive 必须是对象`);
      }
      const keys = Object.keys(d);
      if (keys.length !== 1 || keys[0] !== 'intersect') {
        throw new Error(`module "${name}" 的 derive 只支持 intersect（收到: ${keys.join(',') || '空'}）`);
      }
      const pair = d.intersect;
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        pair.some((m) => typeof m !== 'string' || m === '')
      ) {
        throw new Error(`module "${name}" 的 derive.intersect 必须是两个模块名的数组`);
      }
      if (pair[0] === pair[1]) {
        throw new Error(`module "${name}" 的 derive.intersect 两个模块不能相同: ${pair[0]}`);
      }
      if (pair.includes(name)) {
        throw new Error(`module "${name}" 的 derive.intersect 不能引用自己`);
      }
      modules[name] = { kind, behavior: def.behavior, derive: { intersect: [...pair] } };
      continue;
    }
    modules[name] = {
      kind,
      behavior: def.behavior,
      ...(def.sources ? { sources: [...def.sources] } : {}),
      ...(def.custom ? { custom: def.custom } : {}),
    };
  }
  return modules;
}

/** 读取规则顺序；校验模块存在、不重复、目标组合法。 */
export function loadOrder(path, { modules } = {}) {
  const raw = readYaml(path);
  if (!Array.isArray(raw)) throw new Error(`order 必须是数组: ${path}`);
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item.module !== 'string' || item.module === '') {
      throw new Error(`order[${i}].module 缺失或为空`);
    }
    if (!TARGETS.has(item.target)) {
      throw new Error(`order[${i}].target 非法: ${item.target}（只允许 reject/direct/proxies/f1tv）`);
    }
    if (seen.has(item.module)) {
      throw new Error(`order 中模块重复: ${item.module}`);
    }
    seen.add(item.module);
    if (modules && !(item.module in modules)) {
      throw new Error(`order 引用了不存在的模块: ${item.module}`);
    }
    const entry = { module: item.module, target: item.target };
    if (item.no_resolve === true) entry.no_resolve = true;
    return entry;
  });
}

/** 读取三份真相文件，并校验交叉引用与自定义文件存在性。 */
export function loadAll(rootDir = process.cwd()) {
  const at = (p) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const regions = loadRegions(at('config/regions.yaml'));
  const modules = loadModules(at('rules/modules.yaml'));
  const order = loadOrder(at('rules/order.yaml'), { modules });

  for (const [name, mod] of Object.entries(modules)) {
    if (mod.custom && !existsSync(at(mod.custom))) {
      throw new Error(`module "${name}" 的 custom 文件不存在: ${mod.custom}`);
    }
    if (!mod.derive) continue;
    for (const dep of mod.derive.intersect) {
      const src = modules[dep];
      if (!src) throw new Error(`module "${name}" 的 derive.intersect 引用了不存在的模块: ${dep}`);
      if (src.kind === 'remote') {
        throw new Error(`module "${name}" 的 derive.intersect 不能引用 remote 模块: ${dep}`);
      }
      if (src.derive) {
        throw new Error(`module "${name}" 的 derive.intersect 不能引用另一个 derive 模块: ${dep}`);
      }
    }
  }
  for (const entry of order) {
    if (!(entry.module in modules)) {
      throw new Error(`order 引用了不存在的模块: ${entry.module}`);
    }
  }
  return { regions, modules, order };
}
