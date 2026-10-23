import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { parse, stringify } from 'yaml';

const execFileAsync = promisify(execFile);

const FAKE_PROXIES = [
  { name: '🇭🇰Hong Kong 03', type: 'ss', server: '1.1.1.1', port: 8388, cipher: 'aes-128-gcm', password: 'x' },
  { name: '🇺🇸United States 01', type: 'ss', server: '1.1.1.2', port: 8388, cipher: 'aes-128-gcm', password: 'x' },
];

async function hasMihomo() {
  try {
    await execFileAsync('mihomo', ['-v']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 运行时冒烟（mihomo）：把脚本跑出来的 proxy-groups 注入模板，交给 `mihomo -t` 校验。
 * 为什么需要它：`mihomo -t` 只验模板时看不到脚本生成的组（例如把 url-test 写成 urltest 这类错误）。
 */
export async function probeMihomo({ configPath = 'dist/mihomo/config.yaml', scriptPath = 'dist/scripts/mihomo.js' } = {}) {
  const config = parse(readFileSync(configPath, 'utf8'));
  config.proxies = FAKE_PROXIES;

  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(scriptPath, 'utf8'), ctx);
  if (typeof ctx.main !== 'function') throw new Error('mihomo 脚本没有导出 main(config)');
  const rendered = ctx.main(config);

  const dir = mkdtempSync(join(tmpdir(), 'ssc-probe-mihomo-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(file, stringify(rendered, { lineWidth: 0 }));

  if (!(await hasMihomo())) return { ok: true, skipped: 'mihomo 未安装', problems: [] };

  try {
    await execFileAsync('mihomo', ['-t', '-f', file]);
    return { ok: true, problems: [] };
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
    return { ok: false, problems: out.split('\n').filter((l) => /error|unsupport|invalid/i.test(l)).slice(0, 5) };
  }
}
