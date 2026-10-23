/** clash 规则行 ↔ 内部条目（Entry）↔ 两端产物 的转换 */

/** clash 类型名 → sing-box headless 字段名 */
const FIELD_OF = {
  DOMAIN: 'domain',
  'DOMAIN-SUFFIX': 'domain_suffix',
  'DOMAIN-KEYWORD': 'domain_keyword',
  'DOMAIN-REGEX': 'domain_regex',
  'IP-CIDR': 'ip_cidr',
  'IP-CIDR6': 'ip_cidr',
  'PROCESS-NAME': 'process_name',
};

/** 反向：headless 字段 → clash 类型名（写 mihomo payload 用） */
const TYPE_OF = {
  domain: 'DOMAIN',
  domain_suffix: 'DOMAIN-SUFFIX',
  domain_keyword: 'DOMAIN-KEYWORD',
  domain_regex: 'DOMAIN-REGEX',
  ip_cidr: 'IP-CIDR',
  process_name: 'PROCESS-NAME',
};

/** headless 字段的固定输出顺序（同一字段一条 rule） */
const FIELD_ORDER = [
  'domain',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
  'ip_cidr',
  'process_name',
];

/** 各 behavior 允许出现的字段 */
const FIELDS_OF_BEHAVIOR = {
  domain: ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex'],
  ipcidr: ['ip_cidr'],
  classical: FIELD_ORDER,
};

const stripQuotes = (s) => s.replace(/^'/, '').replace(/'$/, '').replace(/^"/, '').replace(/"$/, '');

/**
 * 解析 clash 规则文本。兼容两种上游格式：
 *  - 纯行：`DOMAIN-SUFFIX,x` / `1.1.1.0/24`
 *  - YAML payload：`payload:` 头 + `  - 'DOMAIN-SUFFIX,x'`
 * 无逗号的纯值按 defaultType 解释（IP 列表传 'IP-CIDR'）。未知类型一律抛错，不静默丢弃。
 */
export function parseClashText(text, { defaultType = 'DOMAIN' } = {}) {
  if (!(defaultType in FIELD_OF)) {
    throw new Error(`defaultType 非法: ${defaultType}`);
  }
  const entries = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line === 'payload:') continue;
    if (line.startsWith('- ')) line = line.slice(2).trim();
    else if (line.startsWith('-')) line = line.slice(1).trim();
    line = stripQuotes(line).trim();
    line = line.replace(/\s+#.*$/, '').trim(); // 行尾注释
    if (line === '') continue;

    if (line.startsWith('+.')) {
      entries.push({ type: 'DOMAIN-SUFFIX', value: line.slice(2) });
      continue;
    }

    const comma = line.indexOf(',');
    if (comma === -1) {
      entries.push({ type: defaultType, value: line });
      continue;
    }

    const type = line.slice(0, comma).trim().toUpperCase();
    const value = line.slice(comma + 1).trim();
    if (value.includes(',')) {
      throw new Error(`规则值里出现多余逗号（多列规则不被支持）: ${line}`);
    }
    if (!(type in FIELD_OF)) {
      throw new Error(`不支持的规则类型: ${type}（原文: ${line}）`);
    }
    if (value === '') throw new Error(`规则值为空: ${line}`);
    entries.push({ type, value });
  }
  return entries;
}

/** 把自定义 YAML 对象转成 Entry[]；字段与 behavior 不匹配时抛错。 */
export function normalizeCustom(obj, behavior) {
  if (!FIELDS_OF_BEHAVIOR[behavior]) throw new Error(`behavior 非法: ${behavior}`);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('自定义规则必须是对象');
  }
  const allowed = new Set(FIELDS_OF_BEHAVIOR[behavior]);
  const buckets = new Map();
  for (const [field, values] of Object.entries(obj)) {
    if (!(field in TYPE_OF)) throw new Error(`自定义规则字段不支持: ${field}`);
    if (!allowed.has(field)) {
      throw new Error(`behavior=${behavior} 不允许字段 ${field}`);
    }
    if (!Array.isArray(values)) throw new Error(`自定义规则字段 ${field} 必须是数组`);
    for (const v of values) {
      if (typeof v !== 'string') {
        throw new Error(`自定义规则 ${field} 的条目必须是字符串（收到 ${typeof v}）`);
      }
      if (v.trim() === '') continue;
      const list = buckets.get(field) ?? [];
      list.push(stripQuotes(v.trim()));
      buckets.set(field, list);
    }
  }
  const entries = [];
  for (const field of FIELD_ORDER) {
    for (const value of buckets.get(field) ?? []) {
      entries.push({ type: TYPE_OF[field], value });
    }
  }
  return entries;
}

/** Entry[] → sing-box source rule-set：一个字段一条 rule（rules 之间为 OR）。 */
export function toHeadless(entries, version = 3) {
  const buckets = new Map();
  for (const { type, value } of entries) {
    const field = FIELD_OF[type];
    if (!field) throw new Error(`不支持的规则类型: ${type}`);
    const list = buckets.get(field) ?? [];
    list.push(value);
    buckets.set(field, list);
  }
  const rules = [];
  for (const field of FIELD_ORDER) {
    const values = buckets.get(field);
    if (values && values.length > 0) rules.push({ [field]: values });
  }
  return { version, rules };
}

/** Entry[] → mihomo rule-provider payload 行（保持 clash 类型名，供 classical 行为用）。 */
export function toMihomoLines(entries) {
  return entries.map(({ type, value }) => `${type},${value}`);
}

/**
 * Entry[] → mihomo rule-provider 的 payload 条目，形态随 behavior 变化：
 *  - domain：`DOMAIN-SUFFIX` → `+.x`，`DOMAIN` → `x`（关键词/正则/进程在该行为下无法表达，直接抛错）
 *  - ipcidr：裸 CIDR
 *  - classical：完整规则行
 */
export function toMihomoPayload(entries, behavior) {
  if (behavior === 'classical') return toMihomoLines(entries);
  if (behavior === 'ipcidr') {
    return entries.map(({ type, value }) => {
      if (type !== 'IP-CIDR' && type !== 'IP-CIDR6') {
        throw new Error(`ipcidr 行为不支持条目类型: ${type},${value}`);
      }
      return value;
    });
  }
  if (behavior === 'domain') {
    return entries.map(({ type, value }) => {
      if (type === 'DOMAIN-SUFFIX') return `+.${value}`;
      if (type === 'DOMAIN') return value;
      throw new Error(`domain 行为不支持条目类型: ${type},${value}（改用 classical）`);
    });
  }
  throw new Error(`behavior 非法: ${behavior}`);
}

/** 按 `type + 空格 + value` 去重，保持首次出现顺序。 */
export function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = `${entry.type} ${entry.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}
