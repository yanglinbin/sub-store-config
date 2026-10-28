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
  assert.equal(c.route.rule_set[0].url, `${BASE}/singbox/rules/overrides.srs`);
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
  assert.deepEqual(routeRules[0], { rule_set: 'overrides', action: 'route', outbound: 'proxies' });
  assert.deepEqual(routeRules[1], { rule_set: 'subscription', action: 'route', outbound: 'proxies' });
  assert.deepEqual(routeRules[2], { rule_set: 'selfhost', action: 'route', outbound: 'direct' });
  assert.deepEqual(routeRules[3], { rule_set: 'private', action: 'route', outbound: 'direct' });
  // proxy 在 direct 之前：靠顺序而非域名例外清单解决 *.cn 误判
  const idxProxy = routeRules.findIndex((r) => r.rule_set === 'proxy');
  const idxDirect = routeRules.findIndex((r) => r.rule_set === 'direct');
  assert.ok(idxProxy > -1 && idxProxy < idxDirect, 'proxy 必须在 direct 之前');
  // direct-pinned 在 proxy 之前，且在 resolve 之前
  const idxPinned = routeRules.findIndex((r) => r.rule_set === 'direct-pinned');
  assert.ok(idxPinned > -1 && idxPinned < idxProxy);
  assert.ok(routeRules.findIndex((r) => r.rule_set === 'direct-pinned') < idxResolve);
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

test('DNS 分流：国内域名主用 local + DNSPod 兜底、代理域名走 fakeip、其余类型走 local', () => {
  const c = render();
  const rules = c.dns.rules;
  const find = (m) => rules.filter((r) => Array.isArray(r.rule_set) && r.rule_set.includes(m));
  const direct = find('direct');
  assert.equal(direct[0].action, 'evaluate', '国内域名先问阿里 DNS');
  assert.equal(direct[0].server, 'local-dns');
  assert.equal(direct[0].timeout, '1s', '1s 没答就换备用，不要拖');
  assert.deepEqual(direct[1], { rule_set: ['direct'], match_response: true, action: 'respond' });
  assert.equal(direct[2].server, 'local-dns-2', '阿里没答时换 DNSPod');
  assert.equal(direct[2].action, 'route');
  // 两台国内 DNS 不能同时匿名 evaluate：结果会被后一条覆盖（sing-box 启动会告警）
  assert.ok(!direct.some((r) => r.action === 'evaluate' && r.server === 'local-dns-2'));

  const gfw = find('gfw');
  assert.equal(gfw.length, 1, '代理域名只要一条 fakeip 规则');
  assert.equal(gfw[0].server, 'fakeip', '代理域名用 fakeip，解析交给出口侧');
  assert.deepEqual(gfw[0].query_type, ['A', 'AAAA']);

  // 非 A/AAAA（TXT/SRV 等）不能被本地 DNS 回答，但也不该跨洋去问
  const rest = rules.find((r) => r.invert === true);
  assert.deepEqual(rest, { query_type: ['A', 'AAAA'], invert: true, action: 'route', server: 'local-dns' });
  assert.equal(c.dns.final, 'local-dns');
  assert.equal(c.dns.strategy, 'prefer_ipv4');
  assert.equal(c.dns.timeout, '5s');
  assert.equal(c.dns.optimistic, true);
  assert.equal(c.dns.cache_capacity, 8192);
});

test('DNS 前置：AAAA 与 HTTPS/SVCB 一律空回答（NOERROR）', () => {
  const c = render();
  const rules = c.dns.rules;
  const aaaa = rules.find((r) => Array.isArray(r.query_type) && r.query_type.length === 1 && r.query_type[0] === 'AAAA');
  assert.deepEqual(aaaa, { query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' });
  const https = rules.find((r) => Array.isArray(r.query_type) && r.query_type.includes('SVCB'));
  assert.deepEqual(https, { query_type: ['HTTPS', 'SVCB'], action: 'predefined', rcode: 'NOERROR' });
  // 必须用 predefined(NOERROR)，不能用 reject：reject 默认回 REFUSED，且 50 次/30s 后退化成 drop
  assert.ok(!JSON.stringify(rules).includes('"reject"'), 'reject 会 REFUSED/丢包，不能用');
  // 必须排在域名模块之前，否则 fakeip 域名也会先被解析
  const idxHttps = rules.indexOf(https);
  const idxFirstModule = rules.findIndex((r) => Array.isArray(r.rule_set));
  assert.ok(idxHttps < idxFirstModule, 'AAAA/HTTPS 拦截要放在域名分派之前');
});

test('DNS 未命中域名：本地 + 境外两路并发 evaluate + race 抢先采用国内答案', () => {
  const c = render();
  const rules = c.dns.rules;
  // 只看“未命中任何域名表”那三条匿名 evaluate（不带 rule_set 的尾部）
  const tail = rules.filter((r) => !r.rule_set && !r.domain_suffix && r.action === 'evaluate');
  const idxLocal = rules.indexOf(tail[0]);
  const idxRemote = rules.indexOf(tail.find((r) => r.server === 'remote-dns'));
  const idxRemote2 = rules.indexOf(tail.find((r) => r.server === 'remote-dns-2'));
  assert.ok(idxLocal > 0 && idxRemote === idxLocal + 1 && idxRemote2 === idxRemote + 1, '三条查询必须在任何 race 规则之前发出，才能并行');
  assert.equal(rules[idxLocal].timeout, '2s', '本地那路给 2s 超时，别把远端答案一起拖死');
  assert.equal(rules[idxRemote].tag, 'remote-answer');
  assert.equal(rules[idxRemote2].tag, 'remote-answer-2');

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
  assert.deepEqual(rules[idxFallback + 1], { match_response: 'remote-answer-2', action: 'respond' });
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
