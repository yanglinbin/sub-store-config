import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateDist } from '../build/validate.mjs';

/**
 * 造一份最小 dist。两端模板都要有 rule_set / rule-providers，
 * 否则 url↔format 一致性校验在单测里跑不到。
 */
function makeDist(
  mihomoRules,
  singboxRules,
  { ruleProviderFormat = 'text', ruleSetFormat = 'binary', ruleProviderUrl = 'https://x/a.list' } = {},
) {
  const d = mkdtempSync(join(tmpdir(), 'ssc-v-'));
  mkdirSync(join(d, 'mihomo'), { recursive: true });
  mkdirSync(join(d, 'singbox/rules'), { recursive: true });

  writeFileSync(
    join(d, 'mihomo/config.yaml'),
    stringify({
      rules: mihomoRules,
      'proxy-groups': [],
      'rule-providers': {
        a: { type: 'http', behavior: 'domain', format: ruleProviderFormat, url: ruleProviderUrl },
      },
    }),
  );
  writeFileSync(
    join(d, 'singbox/template.json'),
    JSON.stringify({
      outbounds: [],
      dns: {},
      route: {
        // ruleSetFormat 传 null 表示省略 format（sing-box 会按扩展名推断，合法）
        rule_set: [
          {
            type: 'remote',
            tag: 'a',
            ...(ruleSetFormat === null ? {} : { format: ruleSetFormat }),
            url: 'https://x/a.srs',
          },
        ],
        rules: singboxRules,
      },
    }),
  );
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

test('sing-box 省略 format（按扩展名推断）是合法的，不误报', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }], { ruleSetFormat: null });
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('mihomo rule-provider 用了不支持的扩展名时报错', async () => {
  const d = makeDist(['RULE-SET,a,REJECT'], [{ rule_set: 'a', action: 'reject' }], {
    ruleProviderUrl: 'https://x/a.yaml', // 只支持 .list / .mrs
  });
  const r = await validateDist({ distDir: d, baseUrl: 'x', skipBinaries: true });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('扩展名不支持')));
});
