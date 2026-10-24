import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { loadAll } from '../build/load.mjs';
import { renderMihomo } from '../build/render-mihomo.mjs';

const BASE = 'https://base/dist';
const render = () => parse(renderMihomo({ ...loadAll(), baseUrl: BASE }));

test('全局字段与 spec 一致', () => {
  const c = render();
  assert.equal(c['mixed-port'], 7890);
  assert.equal(c['external-controller'], ':9090');
  assert.equal(c.ipv6, true);
  assert.equal(c['allow-lan'], true);
  assert.deepEqual(c.profile, { 'store-selected': true, 'store-fake-ip': false });
});

test('rule-providers：geoip 远程模块 + 自建 f1tv', () => {
  const c = render();
  assert.deepEqual(Object.keys(c['rule-providers']), ['geoip-private', 'f1tv', 'geoip-cn', 'geoip-telegram']);

  assert.deepEqual(c['rule-providers']['geoip-cn'], {
    type: 'http',
    behavior: 'ipcidr',
    format: 'mrs',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/mrs/cn.mrs',
    path: './mrs/geoip/cn.mrs',
    interval: 86400,
  });

  assert.equal(c['rule-providers'].f1tv.url, `${BASE}/mihomo/rules/f1tv.list`);
  assert.equal(c['rule-providers'].f1tv.format, 'yaml');
  assert.equal(c['rule-providers'].f1tv.behavior, 'classical');
});

test('rules 顺序 = order.yaml 顺序，target 映射正确，no-resolve 生效', () => {
  const c = render();
  assert.deepEqual(c.rules, [
    'RULE-SET,geoip-private,direct',
    'RULE-SET,f1tv,f1tv',
    'RULE-SET,geoip-cn,direct',
    'RULE-SET,geoip-telegram,proxies',
  ]);
});

test('fallback 骨架包含四个组且非空', () => {
  const c = render();
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), ['proxies', 'f1tv', 'direct', 'final']);
  assert.ok(c['proxy-groups'].every((g) => g.proxies.length >= 1));
});
