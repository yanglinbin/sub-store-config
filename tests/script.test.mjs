import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { emitScripts } from '../build/emit-script.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'ssc-scripts-'));
const template = JSON.stringify(
  {
    inbounds: [],
    route: { rules: [], rule_set: [] },
    experimental: {},
    outbounds: [
      { type: 'selector', tag: 'proxies', outbounds: ['DIRECT'], default: 'DIRECT' },
      { type: 'selector', tag: 'direct', outbounds: ['DIRECT'] },
      { type: 'selector', tag: 'f1tv', outbounds: ['DIRECT'] },
      { type: 'selector', tag: 'final', outbounds: ['DIRECT'], default: 'DIRECT' },
      { type: 'direct', tag: 'DIRECT' },
    ],
  },
  null,
  2,
);

async function runSingbox(proxies) {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const ctx = {
    $arguments: { name: 'kitty' },
    $files: [template],
    $content: null,
    produceArtifact: async () => proxies,
    console,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {\n${code}\n})()`, ctx);
  return JSON.parse(ctx.$content);
}

test('singbox 脚本注入节点、生成地区组与四个组', async () => {
  const cfg = await runSingbox([
    { type: 'vless', tag: '🇭🇰Hong Kong 03' },
    { type: 'vless', tag: '🇺🇸United States 01' },
  ]);
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  assert.equal(byTag['香港'].type, 'urltest');
  assert.deepEqual(byTag['香港'].outbounds, ['🇭🇰Hong Kong 03']);
  assert.deepEqual(byTag.proxies.outbounds.slice(0, 2), ['香港', '美国']);
  assert.equal(byTag.proxies.default, '香港');
  assert.equal(byTag.direct.outbounds[0], 'DIRECT');
  assert.ok(byTag.proxies.outbounds.includes('🇭🇰Hong Kong 03'));
  assert.equal(byTag.final.outbounds[0], 'DIRECT');
});

test('订阅为空时仍产出可启动配置', async () => {
  const cfg = await runSingbox([]);
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  for (const t of ['proxies', 'direct', 'f1tv', 'final']) {
    assert.ok(byTag[t].outbounds.length > 0, t);
  }
  assert.ok(cfg.outbounds.some((o) => o.type === 'direct' && o.tag === 'DIRECT'));
});

test('mihomo 脚本按 config.proxies 重建 proxy-groups', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'mihomo.js'), 'utf8');
  const ctx = { $arguments: { name: 'kitty' }, console };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const out = ctx.main({
    proxies: [{ name: '🇭🇰Hong Kong 03', type: 'ss' }],
    'proxy-groups': [],
  });
  const byName = Object.fromEntries(out['proxy-groups'].map((g) => [g.name, g]));
  assert.equal(byName.final.proxies[0], 'DIRECT');
  assert.equal(byName.proxies.proxies.at(-1), 'DIRECT');
  assert.ok(byName.proxies.proxies.includes('🇭🇰Hong Kong 03'));
});
