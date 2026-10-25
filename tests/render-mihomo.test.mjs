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
  assert.equal(c['external-controller'], '127.0.0.1:9090');
  assert.equal(c.ipv6, true);
  assert.equal(c['allow-lan'], true);
  assert.deepEqual(c.profile, { 'store-selected': true, 'store-fake-ip': true });
});

test('rule-providers：全部来自 clash-rules 构建产物，且用 text 格式', () => {
  const c = render();
  assert.equal(Object.keys(c['rule-providers']).length, 15);

  assert.deepEqual(c['rule-providers']['category-ads-all'], {
    type: 'http',
    behavior: 'domain',
    format: 'text',
    proxy: 'proxies',
    url: `${BASE}/mihomo/rules/category-ads-all.list`,
    path: './ruleset/category-ads-all.yaml',
    interval: 86400,
  });
  assert.equal(c['rule-providers'].cncidr.behavior, 'ipcidr');
  assert.equal(c['rule-providers'].cncidr.format, 'text');
  assert.equal(c['rule-providers'].f1tv.behavior, 'classical');
  assert.equal(c['rule-providers'].gfw.url, `${BASE}/mihomo/rules/gfw.list`);
  assert.equal(c['rule-providers'].google.url, `${BASE}/mihomo/rules/google.list`);
});

test('rules 顺序 = order.yaml 顺序，且以 MATCH,final 兜底', () => {
  const c = render();
  assert.deepEqual(c.rules, [
    'RULE-SET,category-ads-all,REJECT',
    'RULE-SET,private,direct',
    'RULE-SET,f1tv,f1tv',
    'RULE-SET,microsoft,direct',
    'RULE-SET,apple,direct',
    'RULE-SET,icloud,direct',
    'RULE-SET,steam,direct',
    'RULE-SET,applications,direct',
    'RULE-SET,google,proxies',
    'RULE-SET,gfw,proxies',
    'RULE-SET,direct,direct',
    'RULE-SET,proxy,proxies',
    'RULE-SET,lancidr,direct',
    'RULE-SET,cncidr,direct',
    'RULE-SET,telegramcidr,proxies',
    'MATCH,final',
  ]);
});

test('安全与解析相关全局项', () => {
  const c = render();
  assert.equal(c['external-controller'], '127.0.0.1:9090', '控制 API 不能绑 0.0.0.0');
  assert.equal(c.sniffer.enable, true, '缺 sniffer 时纯 IP / DoH 连接无法按域名分流');
  assert.equal(c.dns['enhanced-mode'], 'fake-ip');
  assert.deepEqual(c.dns['proxy-server-nameserver'], ['https://223.5.5.5/dns-query']);
  assert.ok(!('proxy-providers' in c), 'proxy-providers 是死键');
});

test('fallback 骨架包含四个组且非空', () => {
  const c = render();
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), ['proxies', 'f1tv', 'direct', 'final']);
  assert.ok(c['proxy-groups'].every((g) => g.proxies.length >= 1));
});
