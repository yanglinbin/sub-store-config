import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegions, loadModules, loadOrder, loadAll } from '../build/load.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ssc-'));

test('regions 解析出 10 个地区且字段齐全', () => {
  const regions = loadRegions('config/regions.yaml');
  assert.equal(regions.length, 5);
  assert.deepEqual(regions[0], {
    name: '香港',
    flag: '🇭🇰',
    keywords: ['香港', 'hk', 'hongkong', 'hong kong'],
  });
});

test('order 引用不存在的 module 时抛错并点名', () => {
  const d = tmp();
  writeFileSync(join(d, 'm.yaml'), 'a:\n  behavior: domain\n');
  writeFileSync(join(d, 'o.yaml'), '- { module: nope, target: direct }\n');
  assert.throws(
    () => loadOrder(join(d, 'o.yaml'), { modules: loadModules(join(d, 'm.yaml')) }),
    /nope/,
  );
});

test('order 重复 module 抛错', () => {
  const d = tmp();
  writeFileSync(
    join(d, 'o.yaml'),
    '- { module: a, target: direct }\n- { module: a, target: proxies }\n',
  );
  assert.throws(
    () => loadOrder(join(d, 'o.yaml'), { modules: { a: { behavior: 'domain' } } }),
    /重复/,
  );
});

test('非法 behavior 抛错', () => {
  const d = tmp();
  writeFileSync(join(d, 'm.yaml'), 'a:\n  behavior: geoip\n');
  assert.throws(() => loadModules(join(d, 'm.yaml')), /behavior/);
});

test('loadAll 读通仓库真实配置', () => {
  const { regions, modules, order } = loadAll();
  assert.equal(order.length, 18);
  assert.equal(Object.keys(modules).length, 18);
  assert.ok(regions.every((r) => Array.isArray(r.keywords) && r.keywords.length > 0));
});

test('proxy 必须排在 direct 之前，否则 proxy 里的 *.cn 域名被 direct 的裸 cn 通配吞掉', () => {
  const { order } = loadAll();
  const idx = (m) => order.findIndex((x) => x.module === m);
  assert.ok(idx('proxy') > -1 && idx('direct') > -1);
  assert.ok(idx('proxy') < idx('direct'), 'proxy 必须在 direct 之前');
  assert.equal(order[idx('proxy')].target, 'proxies');
});

test('direct-pinned 是派生模块，排在 proxy/direct 之前且 target=direct', () => {
  const { modules, order } = loadAll();
  const idx = (m) => order.findIndex((x) => x.module === m);
  assert.deepEqual(modules['direct-pinned'].derive, { intersect: ['direct', 'proxy'] });
  assert.ok(idx('direct-pinned') > -1);
  assert.ok(idx('direct-pinned') < idx('proxy'));
  assert.ok(idx('direct-pinned') < idx('direct'));
  assert.equal(order[idx('direct-pinned')].target, 'direct');
});

test('overrides 排在第一条，压过所有上游规则集', () => {
  const { order } = loadAll();
  assert.equal(order[0].module, 'overrides');
  assert.equal(order[0].target, 'proxies');
});

test('derive 校验：intersect 两个模块名、不得引用自己/remote/另一个 derive', () => {
  const d = tmp();
  const base = 'a:\n  behavior: domain\n  sources: ["https://x/a.txt"]\n';
  const write = (extra) => {
    writeFileSync(join(d, 'm.yaml'), base + extra);
    return join(d, 'm.yaml');
  };

  assert.throws(
    () => loadModules(write('b:\n  behavior: domain\n  derive: { intersect: [a] }\n')),
    /intersect/,
  );
  assert.throws(
    () => loadModules(write('b:\n  behavior: domain\n  derive: { intersect: [a, a] }\n')),
    /不能相同/,
  );
  assert.throws(
    () => loadModules(write('b:\n  behavior: domain\n  derive: { intersect: [a, b] }\n')),
    /不能引用自己/,
  );
  assert.throws(
    () => loadModules(write('b:\n  behavior: domain\n  derive: { union: [a, c] }\n')),
    /只支持 intersect/,
  );
  assert.throws(
    () =>
      loadModules(
        write('b:\n  behavior: domain\n  sources: ["https://x/b.txt"]\n  derive: { intersect: [a, c] }\n'),
      ),
    /不能与 sources/,
  );

  const ok = loadModules(write('b:\n  behavior: domain\n  derive: { intersect: [a, c] }\n'));
  assert.deepEqual(ok.b.derive, { intersect: ['a', 'c'] });
});

test('derive 引用不存在/remote/派生模块时 loadAll 报错', () => {
  const root = tmp();
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'rules'), { recursive: true });
  writeFileSync(join(root, 'config/regions.yaml'), "- { name: 香港, flag: 🇭🇰, keywords: [HK] }\n");
  const writeModules = (yaml) => writeFileSync(join(root, 'rules/modules.yaml'), yaml);
  writeFileSync(
    join(root, 'rules/order.yaml'),
    '- { module: a, target: direct }\n- { module: b, target: direct }\n- { module: c, target: direct }\n',
  );

  writeModules(
    'a:\n  behavior: domain\n  sources: ["https://x/a.txt"]\nb:\n  behavior: domain\n  derive: { intersect: [a, nope] }\nc:\n  behavior: domain\n  sources: ["https://x/c.txt"]\n',
  );
  assert.throws(() => loadAll(root), /引用了不存在的模块: nope/);

  writeModules(
    'a:\n  behavior: ipcidr\n  kind: remote\n  upstream: geoip\n  category: cn\nb:\n  behavior: domain\n  derive: { intersect: [a, c] }\nc:\n  behavior: domain\n  sources: ["https://x/c.txt"]\n',
  );
  assert.throws(() => loadAll(root), /不能引用 remote 模块: a/);

  writeModules(
    'a:\n  behavior: domain\n  sources: ["https://x/a.txt"]\nb:\n  behavior: domain\n  derive: { intersect: [a, c] }\nc:\n  behavior: domain\n  derive: { intersect: [a, b] }\n',
  );
  assert.throws(() => loadAll(root), /不能引用另一个 derive 模块/);
});
