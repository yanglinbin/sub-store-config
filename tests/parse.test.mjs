import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClashText,
  normalizeCustom,
  toHeadless,
  toMihomoLines,
  dedupe,
} from '../build/parse.mjs';

test('兼容 clash 的 YAML payload 格式（上游真实格式）', () => {
  const payload = ["payload:", "  - 'DOMAIN-SUFFIX,icloud.com'", '  - "DOMAIN,apple.com"', ''].join('\n');
  assert.deepEqual(parseClashText(payload), [
    { type: 'DOMAIN-SUFFIX', value: 'icloud.com' },
    { type: 'DOMAIN', value: 'apple.com' },
  ]);
  assert.deepEqual(parseClashText('payload:\n  - 1.1.1.0/24\n', { defaultType: 'IP-CIDR' }), [
    { type: 'IP-CIDR', value: '1.1.1.0/24' },
  ]);
});

test('六种类型逐条转换', () => {
  const text = [
    'DOMAIN,a.com',
    'DOMAIN-SUFFIX,b.com',
    '+.c.com',
    'DOMAIN-KEYWORD,kw',
    'IP-CIDR,1.2.3.0/24',
    'IP-CIDR6,2001:db8::/32',
    'PROCESS-NAME,foo.exe',
    '',
  ].join('\n');
  assert.deepEqual(parseClashText(text), [
    { type: 'DOMAIN', value: 'a.com' },
    { type: 'DOMAIN-SUFFIX', value: 'b.com' },
    { type: 'DOMAIN-SUFFIX', value: 'c.com' },
    { type: 'DOMAIN-KEYWORD', value: 'kw' },
    { type: 'IP-CIDR', value: '1.2.3.0/24' },
    { type: 'IP-CIDR6', value: '2001:db8::/32' },
    { type: 'PROCESS-NAME', value: 'foo.exe' },
  ]);
});

test('未知类型必须抛错而不是丢弃', () => {
  assert.throws(() => parseClashText('GEOIP,CN'), /GEOIP/);
});

test('headless 每个字段独立成一条 rule（AND/OR 语义）', () => {
  const out = toHeadless(parseClashText('DOMAIN,a.com\nDOMAIN,b.com\nIP-CIDR,1.2.3.0/24'));
  assert.deepEqual(out, {
    version: 3,
    rules: [{ domain: ['a.com', 'b.com'] }, { ip_cidr: ['1.2.3.0/24'] }],
  });
});

test('behavior=domain 里出现 ip_cidr 抛错', () => {
  assert.throws(() => normalizeCustom({ ip_cidr: ['1.1.1.1/32'] }, 'domain'), /ip_cidr/);
});

test('behavior=ipcidr 里出现 domain 抛错', () => {
  assert.throws(() => normalizeCustom({ domain: ['a.com'] }, 'ipcidr'), /domain/);
});

test('dedupe 保持顺序且去重', () => {
  const e = parseClashText('DOMAIN,a.com\nDOMAIN,a.com\nDOMAIN,b.com');
  assert.deepEqual(
    dedupe(e).map((x) => x.value),
    ['a.com', 'b.com'],
  );
});

test('mihomo 行输出保持原类型', () => {
  assert.deepEqual(toMihomoLines(parseClashText('+.a.com\nIP-CIDR,1.1.1.0/24')), [
    'DOMAIN-SUFFIX,a.com',
    'IP-CIDR,1.1.1.0/24',
  ]);
});
