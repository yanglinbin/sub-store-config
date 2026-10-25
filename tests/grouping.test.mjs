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
  assert.deepEqual(defs.map((d) => d.name), ['proxies', 'f1tv', 'direct', 'final']);
  assert.deepEqual(defs.find((d) => d.name === 'proxies').members, ['DIRECT']);
  assert.ok(defs.every((d) => d.members.length > 0));
});

test('直连 outbound 统一写 DIRECT；final 默认也是 DIRECT', () => {
  const defs = buildGroupDefs({ names, regions, style: 'mihomo' });
  assert.equal(defs.find((d) => d.name === 'final').members[0], 'DIRECT');
  assert.ok(defs.find((d) => d.name === 'final').members.includes('proxies'));
  assert.equal(defs.find((d) => d.name === 'proxies').members.at(-1), 'DIRECT');
  assert.equal(defs.find((d) => d.name === 'direct').members[0], 'DIRECT');
  const sb = buildGroupDefs({ names, regions, style: 'singbox' });
  assert.equal(sb.find((d) => d.name === 'final').default, 'DIRECT');
  assert.ok(sb.find((d) => d.name === 'direct').members.includes('DIRECT'));
});

test('短关键词按词边界匹配，避免 Australia/Economy/Sweden 误判', () => {
  assert.equal(detectRegion('🇦🇺 Australia 01', regions), null);
  assert.equal(detectRegion('IPLC-01-Economy', regions), null);
  assert.equal(detectRegion('🇸🇪 Sweden 01', regions), null);
  assert.equal(detectRegion('US-01', regions), '美国');
  assert.equal(detectRegion('sg02', regions), '新加坡');
});

test('regionExclude 命中时只从地区组剔除，仍留在 proxies', () => {
  const list = ['🇯🇵 日本W01', '🇯🇵 日本W05 | 下载专用 | x0.01', '🇭🇰 香港W01'];
  const defs = buildGroupDefs({ names: list, regions, style: 'singbox', regionExclude: '下载专用|x0\.01' });
  const jp = defs.find((d) => d.name === '日本');
  assert.deepEqual(jp.members, ['🇯🇵 日本W01']);
  const proxies = defs.find((d) => d.name === 'proxies');
  assert.ok(proxies.members.includes('🇯🇵 日本W05 | 下载专用 | x0.01'));
});

test('测速间隔改为 300s（降低探测频率）', () => {
  const defs = buildGroupDefs({ names, regions, style: 'mihomo' });
  const hk = defs.find((d) => d.name === '香港');
  assert.equal(hk.interval, 300);
  assert.equal(hk.tolerance, 500);
});

test('组顺序：proxies → f1tv → direct → final → 地区组', () => {
  const defs = buildGroupDefs({ names, regions, style: 'singbox' });
  assert.deepEqual(
    defs.map((d) => d.name),
    ['proxies', 'f1tv', 'direct', 'final', '香港', '日本', '美国'],
  );
});
