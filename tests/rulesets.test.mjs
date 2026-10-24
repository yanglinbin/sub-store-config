import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuleSet, writeRuleSets } from '../build/rulesets.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ssc-rs-'));
  mkdirSync(join(root, 'rules/custom'), { recursive: true });
  writeFileSync(join(root, 'rules/custom/c.yaml'), 'domain_suffix:\n  - custom.com\n');
  return root;
}
const fakeFetcher = (map) => ({
  get: async (u) => {
    if (!(u in map)) throw new Error('no ' + u);
    return map[u];
  },
});

test('sources + custom 合并并去重', async () => {
  const root = fixture();
  const { entries } = await buildRuleSet(
    'm',
    { behavior: 'domain', sources: ['https://x/a.txt'], custom: 'rules/custom/c.yaml' },
    {
      rootDir: root,
      fetcher: fakeFetcher({ 'https://x/a.txt': 'DOMAIN-SUFFIX,custom.com\nDOMAIN,a.com' }),
    },
  );
  assert.deepEqual(
    entries.map((e) => `${e.type}:${e.value}`),
    ['DOMAIN-SUFFIX:custom.com', 'DOMAIN:a.com'],
  );
});

test('domain 模块里 custom 写了 ip_cidr 直接失败', async () => {
  const root = fixture();
  writeFileSync(join(root, 'rules/custom/c.yaml'), 'ip_cidr:\n  - 1.1.1.1/32\n');
  await assert.rejects(
    () =>
      buildRuleSet(
        'm',
        { behavior: 'domain', custom: 'rules/custom/c.yaml' },
        { rootDir: root, fetcher: fakeFetcher({}) },
      ),
    /ip_cidr/,
  );
});

test('writeRuleSets 只产出 order 里列出的模块', async () => {
  const root = fixture();
  const distDir = join(root, 'dist');
  const files = await writeRuleSets({
    rootDir: root,
    distDir,
    modules: {
      a: { behavior: 'domain', sources: ['https://x/a.txt'] },
      b: { behavior: 'ipcidr', sources: ['https://x/b.txt'] },
    },
    order: [{ module: 'a', target: 'direct' }],
    fetcher: fakeFetcher({
      'https://x/a.txt': 'DOMAIN,a.com',
      'https://x/b.txt': 'IP-CIDR,1.1.1.0/24',
    }),
  });
  assert.deepEqual(files.sort(), ['mihomo/rules/a.list', 'singbox/rules/a.json']);
  assert.ok(existsSync(join(distDir, 'singbox/rules/a.json')));
  assert.equal(
    readFileSync(join(distDir, 'mihomo/rules/a.list'), 'utf8'),
    'a.com' + String.fromCharCode(10),
  );
});

test('kind=remote 的模块不落盘、不抓取', async () => {
  const root = fixture();
  const distDir = join(root, 'dist');
  const fetched = [];
  const files = await writeRuleSets({
    rootDir: root,
    distDir,
    modules: {
      alias: { kind: 'remote', behavior: 'ipcidr', category: 'cn' },
      a: { behavior: 'domain', sources: ['https://x/a.txt'] },
    },
    order: [
      { module: 'alias', target: 'direct' },
      { module: 'a', target: 'direct' },
    ],
    fetcher: { get: async (u) => { fetched.push(u); return 'DOMAIN,a.com'; } },
  });
  assert.deepEqual(files.sort(), ['mihomo/rules/a.list', 'singbox/rules/a.json']);
  assert.deepEqual(fetched, ['https://x/a.txt']);
  assert.equal(existsSync(join(distDir, 'singbox/rules/alias.json')), false);
});

test('十万条级别的上游文件不爆栈（reject.txt 实测 20 万条）', async () => {
  const root = fixture();
  const big = Array.from({ length: 200_000 }, (_, i) => `DOMAIN-SUFFIX,d${i}.example.com`).join('\n');
  const { entries } = await buildRuleSet(
    'big',
    { behavior: 'domain', sources: ['https://x/big.txt'] },
    { rootDir: root, fetcher: fakeFetcher({ 'https://x/big.txt': 'payload:\n  - ' + big.split('\n').join('\n  - ') }) },
  );
  assert.equal(entries.length, 200_000);
});

test('写出的 .list 是 text 格式（一行一条），条目形态与 behavior 匹配', async () => {
  const root = fixture();
  const distDir = join(root, 'dist');
  await writeRuleSets({
    rootDir: root,
    distDir,
    modules: {
      d: { behavior: 'domain', sources: ['https://x/d.txt'] },
      i: { behavior: 'ipcidr', sources: ['https://x/i.txt'] },
      c: { behavior: 'classical', sources: ['https://x/c.txt'] },
    },
    order: [
      { module: 'd', target: 'direct' },
      { module: 'i', target: 'direct' },
      { module: 'c', target: 'direct' },
    ],
    fetcher: fakeFetcher({
      'https://x/d.txt': 'payload:\n  - DOMAIN-SUFFIX,a.com\n',
      'https://x/i.txt': 'payload:\n  - 1.1.1.0/24\n',
      'https://x/c.txt': 'payload:\n  - PROCESS-NAME,x.exe\n',
    }),
  });
  // text 格式：一行一条，无 YAML 包装
  const read = (m) =>
    readFileSync(join(distDir, `mihomo/rules/${m}.list`), 'utf8').trimEnd().split(String.fromCharCode(10));
  assert.deepEqual(read('d'), ['+.a.com']);
  assert.deepEqual(read('i'), ['1.1.1.0/24']);
  assert.deepEqual(read('c'), ['PROCESS-NAME,x.exe']);
});

test('重建时清掉 dist 里的孤儿产物', async () => {
  const root = fixture();
  const distDir = join(root, 'dist');
  mkdirSync(join(distDir, 'mihomo/rules'), { recursive: true });
  mkdirSync(join(distDir, 'singbox/rules'), { recursive: true });
  writeFileSync(join(distDir, 'mihomo/rules/gone.list'), 'payload:\n  - x\n');
  writeFileSync(join(distDir, 'singbox/rules/gone.json'), '{"version":3,"rules":[]}\n');
  await writeRuleSets({
    rootDir: root,
    distDir,
    modules: { a: { behavior: 'domain', sources: ['https://x/a.txt'] } },
    order: [{ module: 'a', target: 'direct' }],
    fetcher: fakeFetcher({ 'https://x/a.txt': 'DOMAIN,a.com' }),
  });
  assert.equal(existsSync(join(distDir, 'mihomo/rules/gone.list')), false);
  assert.equal(existsSync(join(distDir, 'singbox/rules/gone.json')), false);
});

test('countEntries 统计的是规则条数而不是模块数', async () => {
  const { countEntries } = await import('../build/rulesets.mjs');
  const root = fixture();
  const distDir = join(root, 'dist');
  await writeRuleSets({
    rootDir: root,
    distDir,
    modules: { a: { behavior: 'domain', sources: ['https://x/a.txt'] } },
    order: [{ module: 'a', target: 'direct' }],
    fetcher: fakeFetcher({ 'https://x/a.txt': 'DOMAIN,a.com\nDOMAIN,b.com\nDOMAIN,c.com' }),
  });
  assert.equal(countEntries(distDir), 3);
});
