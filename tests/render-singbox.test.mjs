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
  assert.equal(c.route.rule_set.length, loadAll().order.length);
  assert.equal(c.route.rule_set[0].url, `${BASE}/singbox/rules/subscription.srs`);
  assert.equal(c.route.rule_set[0].format, 'binary');
  assert.equal(c.route.rule_set[0].update_interval, '1d');
});

test('route 规则与 order 一致', () => {
  const c = render();
  // 配置级前置动作：sniff + hijack-dns，否则 fakeip 下 IP 规则无从匹配
  assert.deepEqual(c.route.rules[0], { action: 'sniff' });
  assert.deepEqual(c.route.rules[1], { action: 'hijack-dns', protocol: 'dns' });
  // 第一条 ipcidr 模块前必须自动插入 resolve，否则目标是 fakeip，geoip 规则永不命中
  const idxResolve = c.route.rules.findIndex((r) => r.action === 'resolve');
  const idxFirstIp = c.route.rules.findIndex((r) => r.rule_set === 'lancidr');
  // 所有域名类规则必须都在 resolve 之前（否则每条连接都要强制解析）
  for (const tag of ['google', 'gfw', 'direct', 'proxy']) {
    assert.ok(c.route.rules.findIndex((r) => r.rule_set === tag) < idxResolve, tag + ' 应在 resolve 之前');
  }


  const routeRules = c.route.rules.filter((r) => r.rule_set);
  assert.equal(routeRules.length, loadAll().order.length);
  assert.deepEqual(routeRules[0], { rule_set: 'subscription', action: 'route', outbound: 'proxies' });
  assert.deepEqual(routeRules[1], { rule_set: 'selfhost', action: 'route', outbound: 'direct' });
  assert.deepEqual(routeRules[2], { rule_set: 'private', action: 'route', outbound: 'direct' });
  assert.equal(c.route.rules.filter((r) => r.action === 'reject').length, 0, '广告拦截已按用户要求删除');
  assert.deepEqual(
    routeRules.find((r) => r.rule_set === 'gfw'),
    { rule_set: 'gfw', action: 'route', outbound: 'proxies' },
  );
});

test('1.14 约束：显式 http client、无 independent_cache、无 AAAA reject', () => {
  const c = render();
  assert.equal(c.route.default_http_client, 'direct-download');
  assert.ok(Array.isArray(c.http_clients) && c.http_clients.length === 1);
  assert.ok(!('independent_cache' in c.dns));
  assert.ok(!JSON.stringify(c.dns.rules).includes('"reject"'));
  // NTP 白名单要用后缀，不能是 domain_keyword ["time","ntp"]（会误伤 timesofindia 之类）
  assert.ok(!JSON.stringify(c.dns.rules).includes('"domain_keyword"'));
  assert.equal(c.experimental.cache_file.store_dns, true);
  assert.equal(c.dns.strategy, 'prefer_ipv4');
});

test('tun 双栈 + fakeip 含 v6 段 + final=final', () => {
  const c = render();
  assert.deepEqual(c.inbounds[0].address, ['10.66.0.1/30', 'fdfe:dcba:9876::1/126']);
  const fakeip = c.dns.servers.find((s) => s.type === 'fakeip');
  assert.equal(fakeip.inet6_range, 'fc00::/18');
  assert.equal(c.route.final, 'final');
});

test('不再使用 1.15 将弃置的 tun.stack', () => {
  const tun = render().inbounds.find((i) => i.type === 'tun');
  assert.ok(!('stack' in tun), 'stack 在 1.15 弃用、1.17 移除，删掉即用新栈');
});

test('DNS 分流：国内域名走 local、代理域名走 fakeip、其余类型走 remote', () => {
  const c = render();
  const rules = c.dns.rules;
  const route = (m) => rules.find((r) => Array.isArray(r.rule_set) && r.rule_set.includes(m));
  assert.equal(route('direct').server, 'local-dns', '国内域名用本地 DNS 真实解析');
  assert.equal(route('direct').query_type, undefined, '国内域名所有查询类型都走本地');
  assert.equal(route('gfw').server, 'fakeip', '代理域名用 fakeip，解析交给出口侧');
  assert.deepEqual(route('gfw').query_type, ['A', 'AAAA']);
  // 非 A/AAAA（HTTPS/SVCB 等）不能被本地 DNS 回答
  const rest = rules.find((r) => r.invert === true);
  assert.deepEqual(rest, { query_type: ['A', 'AAAA'], invert: true, action: 'route', server: 'remote-dns' });
  assert.equal(c.dns.final, 'local-dns');
  assert.equal(c.dns.strategy, 'prefer_ipv4');
});

test('DNS 未命中域名：本地/远端并发 evaluate + race 抢先采用国内答案', () => {
  const c = render();
  const rules = c.dns.rules;
  const idxLocal = rules.findIndex((r) => r.action === 'evaluate' && r.server === 'local-dns');
  const idxRemote = rules.findIndex((r) => r.action === 'evaluate' && r.server === 'remote-dns');
  assert.ok(idxLocal > 0 && idxRemote === idxLocal + 1, '两条查询必须在任何 race 规则之前发出，才能并行');
  assert.equal(rules[idxLocal].timeout, '2s', '本地那路给 2s 超时，别把远端答案一起拖死');
  assert.equal(rules[idxRemote].tag, 'remote-answer');

  const idxRace = rules.findIndex((r) => r.race === true);
  assert.ok(idxRace > idxRemote);
  assert.deepEqual(rules[idxRace], {
    match_response: true,
    race: true,
    rule_set: ['lancidr', 'cncidr'],
    action: 'respond',
  });
  // race 与非 race 规则不能写在同一条上（sing-box 会拒绝启动）
  assert.equal(rules.filter((r) => r.race === true).length, 1);
  for (const r of rules.filter((x) => x.race === true)) assert.ok(!r.speculative);

  const idxFallback = rules.findIndex((r) => r.match_response === 'remote-answer');
  assert.deepEqual(rules[idxFallback], { match_response: 'remote-answer', action: 'respond' });
  assert.ok(!('race' in rules[idxFallback]), '远端那条不标 race，等本地 race 判完才生效');
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
