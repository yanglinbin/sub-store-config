import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { emitScripts } from '../build/emit-script.mjs';

const outDir = mkdtempSync(join(tmpdir(), 'ssc-nodes-'));

function run(proxies) {
  return emitScripts({ regionsPath: 'config/regions.yaml', outDir }).then(() => {
    const code = readFileSync(join(outDir, 'nodes.js'), 'utf8');
    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx.operator(proxies);
  });
}

test('剔除信息节点、按 name+server+port 去重、按名称升序', async () => {
  const input = [
    { name: '🇭🇰Hong Kong 03', server: 'h3', port: 443 },
    { name: '🇦🇱 剩余流量：512 GB', server: 'x', port: 1 },
    { name: '🇺🇸United States 01', server: 'u1', port: 443 },
    { name: '🇭🇰Hong Kong 03', server: 'h3', port: 443 },
    { name: '🇦🇱 官网：kitty.fo', server: 'x', port: 2 },
    { name: '🇯🇵Japan 01', server: 'j1', port: 443 },
  ];
  const out = await run(input);
  // 数组来自 vm realm，用字符串比较避免跨 realm 原型差异
  assert.equal(
    out.map((p) => p.name).join('|'),
    ['🇭🇰Hong Kong 03', '🇯🇵Japan 01', '🇺🇸United States 01'].join('|'),
  );
});

test('同名不同 server 视为不同节点，保留两条', async () => {
  const out = await run([
    { name: 'A', server: 's1', port: 443 },
    { name: 'A', server: 's2', port: 443 },
  ]);
  assert.equal(out.length, 2);
});
