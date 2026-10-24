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

test('rule-providers：全部来自 clash-rules 构建产物', () => {
  const c = render();
  assert.equal(Object.keys(c['rule-providers']).length, 16);

  assert.deepEqual(c['rule-providers']['category-ads-all'], {
    type: 'http',
    behavior: 'domain',
    format: 'yaml',
    url: `${BASE}/mihomo/rules/category-ads-all.list`,
    path: './ruleset/category-ads-all.yaml',
    interval: 86400,
  });
  assert.equal(c['rule-providers'].cncidr.behavior, 'ipcidr');
  assert.equal(c['rule-providers'].f1tv.behavior, 'classical');
  assert.equal(c['rule-providers'].google.url, `${BASE}/mihomo/rules/google.list`);
  assert.equal(c['rule-providers'].airport.behavior, 'domain');
});

test('rules 顺序 = order.yaml 顺序，target 映射正确，google 在 cncidr 之前', () => {
  const c = render();
  assert.deepEqual(c.rules, [
    'RULE-SET,airport,direct',
    'RULE-SET,category-ads-all,REJECT',
    'RULE-SET,private,direct',
    'RULE-SET,lancidr,direct',
    'RULE-SET,f1tv,f1tv',
    'RULE-SET,google,proxies',
    'RULE-SET,microsoft,direct',
    'RULE-SET,apple,direct',
    'RULE-SET,icloud,direct',
    'RULE-SET,steam,direct',
    'RULE-SET,applications,direct',
    'RULE-SET,gfw,proxies',
    'RULE-SET,cncidr,direct',
    'RULE-SET,telegramcidr,proxies',
    'RULE-SET,direct,direct',
    'RULE-SET,proxy,proxies',
  ]);
  assert.ok(c.rules.indexOf('RULE-SET,google,proxies') < c.rules.indexOf('RULE-SET,cncidr,direct'));
});

test('fallback 骨架包含四个组且非空', () => {
  const c = render();
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), ['proxies', 'f1tv', 'direct', 'final']);
  assert.ok(c['proxy-groups'].every((g) => g.proxies.length >= 1));
});
