import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function hasSingBox() {
  try {
    await execFileAsync('sing-box', ['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 dist/singbox/rules/*.json 编成 .srs（体积约 1/3）。
 * sing-box 不可用时返回 false，调用方应退化为 source 格式。
 */
export async function compileSrs({ distDir = 'dist', keepJson = true } = {}) {
  if (!(await hasSingBox())) return false;
  const dir = join(distDir, 'singbox/rules');
  if (!existsSync(dir)) return false;

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const src = join(dir, file);
    const out = join(dir, file.replace(/\.json$/, '.srs'));
    await execFileAsync('sing-box', ['rule-set', 'compile', src, '-o', out]);
    if (!keepJson) rmSync(src);
  }
  return true;
}
