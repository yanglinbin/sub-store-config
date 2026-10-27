import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  assert.equal(order.length, 17);
  assert.equal(Object.keys(modules).length, 17);
  assert.ok(regions.every((r) => Array.isArray(r.keywords) && r.keywords.length > 0));
});

test('foreign-cn 必须排在 direct 之前，否则被 direct 的裸 cn 通配吞掉', () => {
  const { order } = loadAll();
  const idx = (m) => order.findIndex((x) => x.module === m);
  assert.ok(idx('foreign-cn') > -1, 'foreign-cn 模块必须在 order 里');
  assert.ok(idx('foreign-cn') < idx('direct'));
  assert.equal(order[idx('foreign-cn')].target, 'proxies');
});
