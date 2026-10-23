import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateDist } from '../build/validate.mjs';

function makeDist(mihomoRules, singboxRules) {
  const d = mkdtempSync(join(tmpdir(), 'ssc-v-'));
  mkdirSync(join(d, 'mihomo'), { recursive: true });
  mkdirSync(join(d, 'singbox/rules'), { recursive: true });
  writeFileSync(join(d, 'mihomo/config.yaml'), stringify({ rules: mihomoRules, 'proxy-groups': [] }));
  writeFileSync(
    join(d, 'singbox/template.json'),
    JSON.stringify({ outbounds: [], dns: {}, route: { rules: singboxRules } }),
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
