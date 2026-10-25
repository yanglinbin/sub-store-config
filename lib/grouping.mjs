/** 纯函数：地区识别 + 四个策略组成员计算（两端共享，由 build/emit-script.mjs 内联进脚本） */

const DIRECT = 'DIRECT';
const SELECT_GROUPS = ['proxies', 'f1tv', 'direct', 'final'];
const URLTEST_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const URLTEST_INTERVAL = 300;
const URLTEST_TOLERANCE = 500;

/** 命中地区：先比 flag 是否出现在名字里，再按 keywords 顺序；多个命中取 regions 顺序第一个。 */
export function detectRegion(name, regions) {
  if (typeof name !== 'string' || name === '') return null;
  const lower = name.toLowerCase();
  for (const region of regions) {
    if (region.flag && name.includes(region.flag)) return region.name;
  }
  // 短关键词（us/hk/de/my...）必须按"词"匹配，否则 Australia→us、Economy→my
  const tokens = lower.split(/[^a-z]+/).filter(Boolean);
  for (const region of regions) {
    for (const keyword of region.keywords) {
      const kw = String(keyword).toLowerCase();
      if (kw.length <= 3 && /^[a-z]+$/.test(kw)) {
        if (tokens.indexOf(kw) !== -1) return region.name;
        continue;
      }
      if (lower.includes(kw)) return region.name;
    }
  }
  return null;
}

/** 按地区分组，保持输入顺序；未命中的进 unmatched。 */
export function groupNodes(names, regions) {
  const byRegion = {};
  const unmatched = [];
  for (const name of names) {
    const region = detectRegion(name, regions);
    if (region === null) {
      unmatched.push(name);
      continue;
    }
    if (!byRegion[region]) byRegion[region] = [];
    byRegion[region].push(name);
  }
  return { byRegion, unmatched };
}

/**
 * 生成策略组定义。顺序固定：direct、f1tv、final、proxies、各地区组。
 * DIRECT 位置：direct/final 首位（即默认项）；proxies/f1tv 末位。地区组不含 DIRECT。
 */
export function buildGroupDefs({ names, regions, style, regionExclude }) {
  if (style !== 'singbox' && style !== 'mihomo') throw new Error(`style 非法: ${style}`);
  // regionExclude：只从"地区组"里剔除（下载专用 / 低倍率节点），它们仍留在 proxies 组
  const excludeRe =
    regionExclude instanceof RegExp
      ? regionExclude
      : regionExclude
        ? new RegExp(regionExclude)
        : null;
  const forRegions = excludeRe ? names.filter((n) => !excludeRe.test(n)) : names;
  const { byRegion } = groupNodes(forRegions, regions);
  const regionNames = regions.filter((r) => byRegion[r.name]?.length).map((r) => r.name);
  const us = regionNames.includes('美国') ? ['美国'] : [];

  const proxies = {
    name: 'proxies',
    type: 'select',
    members: [...regionNames, ...names, DIRECT],
    default: regionNames[0] ?? DIRECT,
  };
  const f1tv = {
    name: 'f1tv',
    type: 'select',
    members: [...us, ...regionNames.filter((r) => r !== '美国'), 'proxies', DIRECT],
    default: us[0] ?? 'proxies',
  };
  const direct = {
    name: 'direct',
    type: 'select',
    members: [DIRECT, ...regionNames, 'proxies'],
    default: DIRECT,
  };
  // final = 未命中任何规则时的兜底：默认直连（用户指定），仍可手选 proxies / 具体地区
  // mihomo 没有 default 字段，默认项 = 成员首项，所以 DIRECT 必须排第一；sing-box 用显式 default
  const final = {
    name: 'final',
    type: 'select',
    members: [DIRECT, 'proxies', ...regionNames],
    default: DIRECT,
  };

  // 顺序即客户端里的显示顺序：proxies → f1tv → direct → final → 各地区组
  const defs = [proxies, f1tv, direct, final];

  for (const regionName of regionNames) {
    defs.push({
      name: regionName,
      type: 'urltest',
      members: [...byRegion[regionName]],
      url: URLTEST_URL,
      interval: URLTEST_INTERVAL,
      tolerance: URLTEST_TOLERANCE,
    });
  }
  return defs;
}

export { DIRECT, SELECT_GROUPS, URLTEST_URL, URLTEST_INTERVAL, URLTEST_TOLERANCE };
