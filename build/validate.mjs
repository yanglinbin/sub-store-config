import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);

const TARGET_OF_MIHOMO = { REJECT: 'reject', direct: 'direct', proxies: 'proxies', f1tv: 'f1tv' };

/** url 扩展名 → 必需的 format：客户端按 format 解析内容，配错就是启动期报错或空规则 */
const SINGBOX_FORMAT_OF_EXT = { '.srs': 'binary', '.json': 'source' };
const MIHOMO_FORMAT_OF_EXT = { '.list': 'text', '.mrs': 'mrs' };

function extensionOf(url) {
  if (typeof url !== 'string' || url === '') return '';
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function checkSingboxFormats(config) {
  const problems = [];
  for (const ruleSet of config.route?.rule_set ?? []) {
    const ext = extensionOf(ruleSet?.url);
    const want = SINGBOX_FORMAT_OF_EXT[ext];
    if (!want) {
      problems.push(`sing-box rule_set "${ruleSet?.tag}" 的 url 扩展名不支持: ${ruleSet?.url}（只允许 .srs / .json）`);
      continue;
    }
    // sing-box 允许省略 format（按 url 扩展名推断），所以只在显式给出时比对
    if (ruleSet.format !== undefined && ruleSet.format !== want) {
      problems.push(`sing-box rule_set "${ruleSet.tag}" 格式不匹配: url 为 ${ext} 时 format 必须是 ${want}，实际 ${ruleSet.format}`);
    }
  }
  return problems;
}

function checkMihomoFormats(config) {
  const problems = [];
  for (const [name, provider] of Object.entries(config['rule-providers'] ?? {})) {
    const ext = extensionOf(provider?.url);
    const want = MIHOMO_FORMAT_OF_EXT[ext];
    if (!want) {
      problems.push(`mihomo rule-provider "${name}" 的 url 扩展名不支持: ${provider?.url}（只允许 .list / .mrs）`);
      continue;
    }
    if (provider.format !== want) {
      problems.push(`mihomo rule-provider "${name}" 格式不匹配: url 为 ${ext} 时 format 必须是 ${want}，实际 ${provider.format}`);
    }
  }
  return problems;
}

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

async function compileAll(files) {
  const problems = [];
  const out = mkdtempSync(join(tmpdir(), 'ssc-srs-'));
  for (const file of files) {
    try {
      if (file.endsWith('.srs')) {
        await execFileAsync('sing-box', ['rule-set', 'decompile', file, '-o', join(out, 'x.json')]);
      } else {
        await execFileAsync('sing-box', ['rule-set', 'compile', file, '-o', join(out, 'x.srs')]);
      }
    } catch (err) {
      problems.push(`rule-set 校验失败 ${file}: ${(err.stderr || err.message || '').trim()}`);
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
 * 校验 dist：语义 diff（两端规则序列）+ rule_set/rule-provider 的 url↔format 一致性
 * + sing-box rule-set 可编译 + 模板可启动。
 * skipBinaries=true 时跳过 sing-box 相关检查（单测用）。
 */
export async function validateDist({ distDir = 'dist', baseUrl, skipBinaries = false } = {}) {
  const dir = resolve(distDir);
  const problems = [];
  const mihomoFile = join(dir, 'mihomo/config.yaml');
  const singboxFile = join(dir, 'singbox/template.json');

  if (!existsSync(mihomoFile)) problems.push('缺少 mihomo/config.yaml');
  if (!existsSync(singboxFile)) problems.push('缺少 singbox/template.json');
  if (existsSync(mihomoFile) && existsSync(singboxFile)) {
    const mihomoConfig = parse(readFileSync(mihomoFile, 'utf8'));
    const singboxConfig = JSON.parse(readFileSync(singboxFile, 'utf8'));
    problems.push(...diffSequences(mihomoConfig, singboxConfig));
    problems.push(...checkSingboxFormats(singboxConfig));
    problems.push(...checkMihomoFormats(mihomoConfig));
  }

  if (!skipBinaries) {
    const rulesDir = join(dir, 'singbox/rules');
    const ruleFiles = existsSync(rulesDir)
      ? readdirSync(rulesDir)
          .filter((f) => f.endsWith('.json') || f.endsWith('.srs'))
          .map((f) => join(rulesDir, f))
      : [];
    if (ruleFiles.length === 0) problems.push('singbox/rules 下没有产物');
    problems.push(...(await compileAll(ruleFiles)));
    if (existsSync(singboxFile)) problems.push(...(await checkTemplate(singboxFile)));
    if (existsSync(join(dir, 'scripts/singbox.js')) === false) problems.push('缺少 scripts/singbox.js');
    if (existsSync(join(dir, 'scripts/mihomo.js')) === false) problems.push('缺少 scripts/mihomo.js');
  }

  return { ok: problems.length === 0, problems };
}

/** CLI：node build/validate.mjs */
if (process.argv[1] && process.argv[1].endsWith('validate.mjs')) {
  const baseUrl = process.env.BASE_URL || 'https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist';
  const r = await validateDist({ distDir: 'dist', baseUrl });
  if (!r.ok) {
    for (const p of r.problems) console.error('✖', p);
    process.exitCode = 1;
  } else {
    console.log('✔ dist 校验通过');
  }
}
