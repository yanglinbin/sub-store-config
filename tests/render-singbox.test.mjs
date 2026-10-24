import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from '../build/load.mjs';
import { renderSingbox } from '../build/render-singbox.mjs';

const BASE = 'https://base/dist';
const render = () => JSON.parse(renderSingbox({ ...loadAll(), baseUrl: BASE }));

test('输出是合法 JSON 且顶层必备键齐全', () => {
  const c = render();
  for (const k of ['log', 'dns', 'inbounds', 'outbounds', 'route', 'experimental', 'http_clients']) {
    assert.ok(k in c, k);
  }
});

test('rule_set 按 order 顺序、url 指向 .srs、format=binary', () => {
  const c = render();
  assert.deepEqual(
    c.route.rule_set.map((r) => r.tag),
    loadAll().order.map((o) => o.module),
  );
  assert.equal(c.route.rule_set.length, 16);
  assert.equal(c.route.rule_set[0].url, `${BASE}/singbox/rules/airport.srs`);
  assert.equal(c.route.rule_set[0].format, 'binary');
  assert.equal(c.route.rule_set[0].update_interval, '1d');
});

test('route 规则与 order 一致（reject 用 action=reject）', () => {
  const c = render();
  // 配置级前置动作：sniff + hijack-dns，否则 fakeip 下 IP 规则无从匹配
  assert.deepEqual(c.route.rules[0], { action: 'sniff' });
  assert.deepEqual(c.route.rules[1], { action: 'hijack-dns', protocol: 'dns' });
  // 第一条 ipcidr 模块前必须自动插入 resolve，否则目标是 fakeip，geoip 规则永不命中
  const idxResolve = c.route.rules.findIndex((r) => r.action === 'resolve');
  const idxFirstIp = c.route.rules.findIndex((r) => r.rule_set === 'lancidr');
  assert.ok(idxResolve > 0 && idxResolve < idxFirstIp, 'resolve 必须在第一条 IP 规则之前');

  const routeRules = c.route.rules.filter((r) => r.rule_set);
  assert.equal(routeRules.length, 16);
  assert.deepEqual(routeRules[0], { rule_set: 'airport', action: 'route', outbound: 'direct' });
  assert.deepEqual(routeRules[1], { rule_set: 'category-ads-all', action: 'reject' });
  const google = routeRules.find((r) => r.rule_set === 'google');
  assert.deepEqual(google, { rule_set: 'google', action: 'route', outbound: 'proxies' });
});

test('1.14 约束：显式 http client、无 independent_cache、无 AAAA reject', () => {
  const c = render();
  assert.equal(c.route.default_http_client, 'direct-download');
  assert.ok(Array.isArray(c.http_clients) && c.http_clients.length === 1);
  assert.ok(!('independent_cache' in c.dns));
  assert.ok(!JSON.stringify(c.dns.rules).includes('"reject"'));
  assert.equal(c.dns.strategy, 'prefer_ipv4');
});

test('tun 双栈 + fakeip 含 v6 段 + final=final', () => {
  const c = render();
  assert.deepEqual(c.inbounds[0].address, ['172.19.0.1/30', 'fdfe:dcba:9876::1/126']);
  const fakeip = c.dns.servers.find((s) => s.type === 'fakeip');
  assert.equal(fakeip.inet6_range, 'fc00::/18');
  assert.equal(c.route.final, 'final');
});

test('模板里的 selector 都带 interrupt_exist_connections', () => {
  const c = render();
  const selectors = c.outbounds.filter((o) => o.type === 'selector');
  assert.ok(selectors.length >= 4);
  assert.ok(selectors.every((s) => s.interrupt_exist_connections === true));
});

test('http_clients 不能 detour 到空 direct outbound（运行时才会报错）', () => {
  const c = render();
  const client = c.http_clients[0];
  assert.equal(client.tag, 'direct-download');
  assert.equal(
    'detour' in client,
    false,
    'sing-box 会报 "detour to an empty direct outbound makes no sense"，应省略 detour',
  );
});
