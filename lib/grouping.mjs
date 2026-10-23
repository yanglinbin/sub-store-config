/** 纯函数：地区识别 + 四个策略组成员计算（两端共享，由 build/emit-script.mjs 内联进脚本） */

const DIRECT = 'DIRECT';
const SELECT_GROUPS = ['direct', 'f1tv', 'final', 'proxies'];
const URLTEST_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const URLTEST_INTERVAL = 60;
const URLTEST_TOLERANCE = 500;

/** 命中地区：先比 flag 是否出现在名字里，再按 keywords 顺序；多个命中取 regions 顺序第一个。 */
export function detectRegion(name, regions) {
  if (typeof name !== 'string' || name === '') return null;
  const lower = name.toLowerCase();
  for (const region of regions) {
    if (region.flag && name.includes(region.flag)) return region.name;
  }
  for (const region of regions) {
    for (const keyword of region.keywords) {
      if (lower.includes(String(keyword).toLowerCase())) return region.name;
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
export function buildGroupDefs({ names, regions, style }) {
  if (style !== 'singbox' && style !== 'mihomo') throw new Error(`style 非法: ${style}`);
  const { byRegion } = groupNodes(names, regions);
  const regionNames = regions.filter((r) => byRegion[r.name]?.length).map((r) => r.name);
  const us = regionNames.includes('美国') ? ['美国'] : [];

  const defs = [
    {
      name: 'direct',
      type: 'select',
      members: [DIRECT, ...regionNames, 'proxies'],
      default: DIRECT,
    },
    {
      name: 'f1tv',
      type: 'select',
      members: [...us, ...regionNames.filter((r) => r !== '美国'), 'proxies', DIRECT],
      default: us[0] ?? 'proxies',
    },
    {
      name: 'final',
      type: 'select',
      members: [DIRECT, ...regionNames, 'proxies'],
      default: DIRECT,
    },
    {
      name: 'proxies',
      type: 'select',
      members: [...regionNames, ...names, DIRECT],
      default: regionNames[0] ?? DIRECT,
    },
  ];

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
