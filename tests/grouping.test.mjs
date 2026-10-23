import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRegion, groupNodes, buildGroupDefs } from '../lib/grouping.mjs';
import { loadRegions } from '../build/load.mjs';

const regions = loadRegions('config/regions.yaml');
const names = [
  '🇭🇰Hong Kong 03',
  '🇺🇸United States 01',
  '🇯🇵Japan 01',
  '🇭🇰 Hong Kong 01 - 美国中转',
  '未知节点',
];

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
  assert.equal(get('direct').members[0], 'DIRECT');
  assert.equal(get('final').members[0], 'DIRECT');
  assert.equal(get('final').default, 'DIRECT');
  assert.equal(get('proxies').members[0], '香港');
  assert.equal(get('proxies').members.at(-1), 'DIRECT');
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
  const sb = buildGroupDefs({ names, regions, style: 'singbox' });
  assert.equal(sb.find((d) => d.name === 'final').members[0], 'DIRECT');
});

test('短关键词按词边界匹配，避免 Australia/Economy/Sweden 误判', () => {
  assert.equal(detectRegion('🇦🇺 Australia 01', regions), null);
  assert.equal(detectRegion('IPLC-01-Economy', regions), null);
  assert.equal(detectRegion('🇸🇪 Sweden 01', regions), null);
  assert.equal(detectRegion('US-01', regions), '美国');
  assert.equal(detectRegion('my02', regions), '马来西亚');
});
