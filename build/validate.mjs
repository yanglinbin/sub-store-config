import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);

const TARGET_OF_MIHOMO = { REJECT: 'reject', direct: 'direct', proxies: 'proxies', f1tv: 'f1tv' };

function diffSequences(mihomoConfig, singboxConfig) {
  const problems = [];
  const a = (mihomoConfig.rules || [])
    .filter((r) => typeof r === 'string' && r.startsWith('RULE-SET,'))
    .map((r) => {
      const [, module, target] = r.split(',');
      return `${module}>${TARGET_OF_MIHOMO[target] ?? target}`;
    });
  const b = (singboxConfig.route?.rules || [])
    .filter((r) => r && r.rule_set)
    .map((r) => `${r.rule_set}>${r.action === 'reject' ? 'reject' : r.outbound}`);
  if (a.length !== b.length) {
    problems.push(`两端规则条数不一致: mihomo ${a.length} / sing-box ${b.length}`);
  }
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) problems.push(`第 ${i + 1} 条规则不一致: mihomo "${a[i]}" / sing-box "${b[i]}"`);
  }
  return problems;
}

async function compileAll(jsonFiles) {
  const problems = [];
  const out = mkdtempSync(join(tmpdir(), 'ssc-srs-'));
  for (const file of jsonFiles) {
    try {
      await execFileAsync('sing-box', ['rule-set', 'compile', file, '-o', join(out, 'x.srs')]);
    } catch (err) {
      problems.push(`rule-set 编译失败 ${file}: ${(err.stderr || err.message || '').trim()}`);
    }
  }
  return problems;
}

async function checkTemplate(file) {
  try {
    await execFileAsync('sing-box', ['check', '-c', file]);
    return [];
  } catch (err) {
    return [`sing-box check 失败: ${(err.stderr || err.message || '').trim()}`];
  }
}

/**
 * 校验 dist：语义 diff（两端规则序列）+ sing-box rule-set 可编译 + 模板可启动。
 * skipBinaries=true 时跳过 sing-box 相关检查（单测用）。
 */
export async function validateDist({ distDir = 'dist', baseUrl, skipBinaries = false } = {}) {
  const dir = resolve(distDir);
  const problems = [];
  const mihomoFile = join(dir, 'mihomo/config.yaml');
  const singboxFile = join(dir, 'singbox/template.json');

  if (!existsSync(mihomoFile)) problems.push(`缺少 ${mihomoFile}`);
  if (!existsSync(singboxFile)) problems.push(`缺少 ${singboxFile}`);

  if (existsSync(mihomoFile) && existsSync(singboxFile)) {
    problems.push(
      ...diffSequences(parse(readFileSync(mihomoFile, 'utf8')), JSON.parse(readFileSync(singboxFile, 'utf8'))),
    );
  }

  if (!skipBinaries) {
    const rulesDir = join(dir, 'singbox/rules');
    const jsonFiles = existsSync(rulesDir)
      ? readdirSync(rulesDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => join(rulesDir, f))
      : [];
    if (jsonFiles.length === 0) problems.push('singbox/rules 下没有产物');
    problems.push(...(await compileAll(jsonFiles)));
    if (existsSync(singboxFile)) problems.push(...(await checkTemplate(singboxFile)));
    if (existsSync(join(dir, 'scripts/singbox.js')) === false) problems.push('缺少 scripts/singbox.js');
    if (existsSync(join(dir, 'scripts/mihomo.js')) === false) problems.push('缺少 scripts/mihomo.js');
  }

  return { ok: problems.length === 0, problems };
}

/** CLI：node build/validate.mjs */
if (process.argv[1] && process.argv[1].endsWith('validate.mjs')) {
  const baseUrl = process.env.BASE_URL || 'https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist';
  const r = await validateDist({ distDir: 'dist', baseUrl });
  if (!r.ok) {
    for (const p of r.problems) console.error('✖', p);
    process.exitCode = 1;
  } else {
    console.log('✔ dist 校验通过');
  }
}
