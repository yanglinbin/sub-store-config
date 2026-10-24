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

test('rule-providers：远程模块指向官方产物，自建模块指向 dist', () => {
  const c = render();
  assert.equal(Object.keys(c['rule-providers']).length, 14);

  // meta-rules-dat（域名类）
  assert.deepEqual(c['rule-providers']['category-ads-all'], {
    type: 'http',
    behavior: 'domain',
    format: 'mrs',
    url: 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/category-ads-all.mrs',
    path: './mrs/geosite/category-ads-all.mrs',
    interval: 86400,
  });
  assert.equal(
    c['rule-providers'].proxy.url,
    'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/geolocation-!cn.mrs',
  );

  // Loyalsoldier/geoip（IP 类）
  assert.deepEqual(c['rule-providers']['geoip-cn'], {
    type: 'http',
    behavior: 'ipcidr',
    format: 'mrs',
    url: 'https://cdn.jsdelivr.net/gh/Loyalsoldier/geoip@release/mrs/cn.mrs',
    path: './mrs/geoip/cn.mrs',
    interval: 86400,
  });

  // 自建（仓库内自定义）
  assert.equal(c['rule-providers'].f1tv.url, `${BASE}/mihomo/rules/f1tv.list`);
  assert.equal(c['rule-providers'].f1tv.format, 'yaml');
});

test('rules 顺序 = order.yaml 顺序，target 映射正确，no-resolve 生效', () => {
  const c = render();
  assert.deepEqual(c.rules, [
    'RULE-SET,category-ads-all,REJECT',
    'RULE-SET,private,direct',
    'RULE-SET,geoip-private,direct,no-resolve',
    'RULE-SET,f1tv,f1tv',
    'RULE-SET,microsoft,direct',
    'RULE-SET,apple,direct',
    'RULE-SET,icloud,direct',
    'RULE-SET,steam,direct',
    'RULE-SET,applications,direct',
    'RULE-SET,gfw,proxies',
    'RULE-SET,geoip-cn,direct,no-resolve',
    'RULE-SET,geoip-telegram,proxies',
    'RULE-SET,direct,direct',
    'RULE-SET,proxy,proxies',
  ]);
});

test('fallback 骨架包含四个组且非空', () => {
  const c = render();
  assert.deepEqual(c['proxy-groups'].map((g) => g.name), ['proxies', 'f1tv', 'direct', 'final']);
  assert.ok(c['proxy-groups'].every((g) => g.proxies.length >= 1));
});
