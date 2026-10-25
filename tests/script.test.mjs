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

async function runSingbox(proxies, args = { name: 'kitty' }) {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const ctx = {
    $arguments: args,
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
  // 组在 outbounds 里的顺序 = 客户端里的显示顺序：proxies → f1tv → direct → final → 地区组
  const groupOrder = cfg.outbounds
    .filter((o) => o.type === 'selector' || o.type === 'urltest')
    .map((o) => o.tag);
  assert.deepEqual(groupOrder, ['proxies', 'f1tv', 'direct', 'final', '香港', '美国']);
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
  // mihomo 的自动测速组类型叫 url-test（带连字符），sing-box 才叫 urltest
  assert.equal(byName['香港'].type, 'url-test');
  assert.equal(byName['香港'].url, 'http://connectivitycheck.gstatic.com/generate_204');
  assert.equal(byName['香港'].interval, 300);
  assert.equal(byName['香港'].lazy, true);
  assert.equal(byName['香港'].tolerance, 500);
});

async function runSingboxWith(produceArtifact) {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const ctx = { $arguments: { name: 'kitty' }, $files: [template], $content: null, produceArtifact, console };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {\n${code}\n})()`, ctx);
  return JSON.parse(ctx.$content);
}

test('produceArtifact 在宏任务里 resolve 时也等得到（不能是悬浮 Promise）', async () => {
  const cfg = await runSingboxWith(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve([{ type: 'vless', tag: '🇭🇰Hong Kong 03' }]), 5),
      ),
  );
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  assert.ok(byTag.proxies.outbounds.includes('🇭🇰Hong Kong 03'));
});

test('produceArtifact 返回 {outbounds:[...]} 形态时也能用', async () => {
  const cfg = await runSingboxWith(async () => ({
    outbounds: [{ type: 'vless', tag: '🇺🇸United States 01' }],
    endpoints: [],
  }));
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));
  assert.ok(byTag.proxies.outbounds.includes('🇺🇸United States 01'));
});

test('脚本产出的配置能被 sing-box 接受，且成员顺序符合规范', async () => {
  const { writeFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');

  const cfg = await runSingbox([
    { type: 'vless', tag: '🇭🇰Hong Kong 03' },
    { type: 'vless', tag: '🇺🇸United States 01' },
    { type: 'vless', tag: '🇯🇵Japan 01' },
  ]);
  const byTag = Object.fromEntries(cfg.outbounds.map((o) => [o.tag, o]));

  assert.equal(byTag.final.outbounds[0], 'DIRECT');
  assert.equal(byTag.final.default, 'DIRECT');
  assert.equal(byTag.direct.outbounds[0], 'DIRECT');
  assert.equal(byTag.f1tv.outbounds[0], '美国');
  assert.equal(byTag.f1tv.outbounds.at(-1), 'DIRECT');
  assert.equal(byTag.proxies.outbounds.at(-1), 'DIRECT');
  assert.deepEqual(byTag.proxies.outbounds.slice(0, 3), ['香港', '日本', '美国']);

  const file = join(outDir, 'e2e.json');
  writeFileSync(file, JSON.stringify(cfg));
  let hasSingBox = true;
  try {
    execFileSync('sing-box', ['version'], { stdio: 'ignore' });
  } catch {
    hasSingBox = false;
  }
  if (hasSingBox) execFileSync('sing-box', ['check', '-c', file], { stdio: 'pipe' });
});

test('生成脚本里的 $ 序列不被替换语义破坏', async () => {
  const { readFileSync } = await import('node:fs');
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'ssc-dollar-'));
  mkdirSync(dir, { recursive: true });
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir: dir });
  const code = readFileSync(join(dir, 'singbox.js'), 'utf8');
  assert.ok(code.includes('buildGroupDefs'), '源码必须完整内联');
  assert.ok(code.includes('const REGIONS ='));
  assert.ok(!code.includes('__GROUPING_SRC__'));
  void execFileSync;
  void writeFileSync;
});

test('脚本生成的 selector 也带 interrupt_exist_connections', async () => {
  const cfg = await runSingbox([{ type: 'vless', tag: '🇭🇰Hong Kong 03' }]);
  const selectors = cfg.outbounds.filter((o) => o.type === 'selector');
  assert.ok(selectors.every((s) => s.interrupt_exist_connections === true));
});

test('支持从组合订阅取节点（#type=col）', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const calls = [];
  const ctx = {
    $arguments: { name: 'air', type: 'col' },
    $files: [template],
    $content: null,
    produceArtifact: async (opts) => {
      calls.push(opts);
      return [{ type: 'vless', tag: '🇭🇰Hong Kong 03' }];
    },
    console: undefined,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {
${code}
})()`, ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'collection');
  assert.equal(calls[0].name, 'air');
  assert.ok(JSON.parse(ctx.$content).outbounds.some((o) => o.tag === '香港'));
});

test('默认仍按单条订阅取节点', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const calls = [];
  const ctx = {
    $arguments: { name: 'kitty' },
    $files: [template],
    $content: null,
    produceArtifact: async (opts) => {
      calls.push(opts);
      return [];
    },
    console: undefined,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {
${code}
})()`, ctx);
  assert.equal(calls[0].type, 'subscription');
});

test('默认不注入 auto_redirect（Windows 会 FATAL）', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const tpl = JSON.parse(template);
  tpl.inbounds = [{ type: 'tun', tag: 'tun-in', auto_route: true, address: ['10.66.0.1/30'] }];
  const ctx = {
    $arguments: { name: 'default' },
    $files: [JSON.stringify(tpl)],
    $content: null,
    produceArtifact: async () => [{ type: 'vless', tag: '🇭🇰Hong Kong 03' }],
    console,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {
${code}
})()`, ctx);
  assert.equal('auto_redirect' in JSON.parse(ctx.$content).inbounds[0], false);
});

test('redirect=1 时给 tun 注入 auto_redirect', async () => {
  await emitScripts({ regionsPath: 'config/regions.yaml', outDir });
  const code = readFileSync(join(outDir, 'singbox.js'), 'utf8');
  const tpl = JSON.parse(template);
  tpl.inbounds = [{ type: 'tun', tag: 'tun-in', auto_route: true, address: ['10.66.0.1/30'] }];
  const ctx = {
    $arguments: { name: 'default', redirect: '1' },
    $files: [JSON.stringify(tpl)],
    $content: null,
    produceArtifact: async () => [{ type: 'vless', tag: '🇭🇰Hong Kong 03' }],
    console,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async () => {\n${code}\n})()`, ctx);
  const out = JSON.parse(ctx.$content);
  assert.equal(out.inbounds[0].auto_redirect, true);
});
