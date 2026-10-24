// 生成物：由 build/emit-script.mjs 从 lib/grouping.mjs + config/regions.yaml 内联生成，勿手改。
// 用途：Sub-Store「文件 → 脚本操作」（普通 file + 远程模板）。
// 参数：#name=<订阅名|组合订阅名>&type=sub|col&noCache=true（type 省略 = 单条订阅）
// 注意：本文件靠顶层 await 完成工作（Sub-Store 会把脚本内联进 async 函数体），
//      不要包成 (async () => { ... })() 悬浮 Promise，否则 $content 会在赋值前被读取。
const REGIONS = [
  {
    "name": "香港",
    "flag": "🇭🇰",
    "keywords": [
      "香港",
      "hk",
      "hongkong",
      "hong kong"
    ]
  },
  {
    "name": "台湾",
    "flag": "🇹🇼",
    "keywords": [
      "台湾",
      "台灣",
      "tw",
      "taiwan"
    ]
  },
  {
    "name": "日本",
    "flag": "🇯🇵",
    "keywords": [
      "日本",
      "jp",
      "japan",
      "tokyo"
    ]
  },
  {
    "name": "美国",
    "flag": "🇺🇸",
    "keywords": [
      "美国",
      "美國",
      "us",
      "usa",
      "america",
      "united states"
    ]
  },
  {
    "name": "新加坡",
    "flag": "🇸🇬",
    "keywords": [
      "新加坡",
      "sg",
      "singapore"
    ]
  },
  {
    "name": "韩国",
    "flag": "🇰🇷",
    "keywords": [
      "韩国",
      "韓國",
      "kr",
      "korea"
    ]
  },
  {
    "name": "马来西亚",
    "flag": "🇲🇾",
    "keywords": [
      "马来西亚",
      "馬來西亞",
      "my",
      "malaysia"
    ]
  },
  {
    "name": "英国",
    "flag": "🇬🇧",
    "keywords": [
      "英国",
      "英國",
      "uk",
      "united kingdom",
      "britain"
    ]
  },
  {
    "name": "德国",
    "flag": "🇩🇪",
    "keywords": [
      "德国",
      "德國",
      "de",
      "germany"
    ]
  },
  {
    "name": "荷兰",
    "flag": "🇳🇱",
    "keywords": [
      "荷兰",
      "荷蘭",
      "nl",
      "netherlands"
    ]
  }
];

/** 纯函数：地区识别 + 四个策略组成员计算（两端共享，由 build/emit-script.mjs 内联进脚本） */

const DIRECT = 'DIRECT';
const SELECT_GROUPS = ['proxies', 'f1tv', 'direct', 'final'];
const URLTEST_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const URLTEST_INTERVAL = 60;
const URLTEST_TOLERANCE = 500;

/** 命中地区：先比 flag 是否出现在名字里，再按 keywords 顺序；多个命中取 regions 顺序第一个。 */
function detectRegion(name, regions) {
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
function groupNodes(names, regions) {
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
function buildGroupDefs({ names, regions, style }) {
  if (style !== 'singbox' && style !== 'mihomo') throw new Error(`style 非法: ${style}`);
  const { byRegion } = groupNodes(names, regions);
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
  const final = {
    name: 'final',
    type: 'select',
    members: [DIRECT, ...regionNames, 'proxies'],
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

const { name, type } = $arguments || {};
if (!name) throw new Error('脚本参数缺少 name（订阅名或组合订阅名）');
const sourceType = /^(col|collection)/i.test(type || '') ? 'collection' : 'subscription';

const config = JSON.parse($files[0]);
const artifact = await produceArtifact({
  type: sourceType,
  name,
  platform: 'sing-box',
  produceType: 'internal',
});
// internal 约定是数组；也兼容 { outbounds, endpoints } 形态
const nodes = Array.isArray(artifact)
  ? artifact
  : artifact && Array.isArray(artifact.outbounds)
    ? artifact.outbounds
    : [];

const tags = nodes.filter((n) => n && n.tag).map((n) => n.tag);
const defs = buildGroupDefs({ names: tags, regions: REGIONS, style: 'singbox' });
const groupTags = ['proxies', 'direct', 'f1tv', 'final'];

const regionOutbounds = defs
  .filter((d) => d.type === 'urltest')
  .map((d) => ({
    type: 'urltest',
    tag: d.name,
    outbounds: d.members,
    url: d.url,
    interval: d.interval + 's',
    tolerance: d.tolerance,
  }));

const selectOutbounds = defs
  .filter((d) => d.type === 'select')
  .map((d) => {
    const out = {
      type: 'selector',
      tag: d.name,
      outbounds: d.members,
      interrupt_exist_connections: true,
    };
    if (d.default) out.default = d.default;
    return out;
  });

// 顺序 = 客户端显示顺序：节点 → 四个 select（proxies/f1tv/direct/final）→ 地区组 → 其余静态 outbound
config.outbounds = [
  ...nodes,
  ...selectOutbounds,
  ...regionOutbounds,
  ...config.outbounds.filter((o) => groupTags.indexOf(o.tag) === -1),
];

$content = JSON.stringify(config, null, 2);
