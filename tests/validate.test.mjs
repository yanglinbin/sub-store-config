import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateDist } from '../build/validate.mjs';

/**
 * 造一份最小 dist。两份模板都要有 rule_set / rule-providers，
 * 否则 url↔format 一致性校验在单测里跑不到。
 */
function makeDist(mihomoRules, singboxRules, { ruleProviderFormat = 'text', ruleSetFormat = 'binary' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ssc-v-'));
  mkdirSync(join(d, 'mihomo'), { recursive: true });
  mkdirSync(join(d, 'singbox/rules'), { recursive: true });
  for (const n of ['config.yaml', 'config-proxy.yaml']) {
    writeFileSync(
      join(d, `mihomo/${n}`),
      stringify({
        rules: mihomoRules,
        'proxy-groups': [],
        'rule-providers': {
          a: { type: 'http', behavior: 'domain', format: ruleProviderFormat, url: 'https://x/a.list' },
        },
      }),
    );
  }
  for (const n of ['template.json', 'template-proxy.json']) {
    writeFileSync(
      join(d, `singbox/${n}`),
      JSON.stringify({
        outbounds: [],
        dns: {},
        route: {
          rule_set: [{ type: 'remote', tag: 'a', format: ruleSetFormat, url: 'https://x/a.srs' }],
          rules: singboxRules,
        },
      }),
    );
  }
  return d;
}

test('两端模块序列不一致时报错', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'b', action: 'reject' }]);
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('不一致')));
});

test('两端一致时通过', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }]);
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, true);
});

test('rule_set/rule-provider 的 url 与 format 不匹配时报错', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }], {
    ruleSetFormat: 'source', // .srs 却声明 source
    ruleProviderFormat: 'mrs', // .list 却声明 mrs
  });
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('sing-box rule_set "a" 格式不匹配')));
  assert.ok(r.problems.some((p) => p.includes('mihomo rule-provider "a" 格式不匹配')));
});

test('url 与 format 完全配套时通过', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }], {
    ruleSetFormat: 'binary',
    ruleProviderFormat: 'text',
  });
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, true);
});
