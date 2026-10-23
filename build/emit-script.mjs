import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadRegions } from './load.mjs';

/** 去掉 ESM 导出语法，得到可直接内联进 Sub-Store 脚本的源码。 */
function inlineSource(path) {
  return readFileSync(path, 'utf8')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .trim();
}

/** 生成 dist/scripts/{singbox,mihomo}.js */
export async function emitScripts({ regionsPath = 'config/regions.yaml', outDir, rootDir = process.cwd() } = {}) {
  if (!outDir) throw new Error('emitScripts 需要 outDir');
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });

  const regions = loadRegions(resolve(rootDir, regionsPath));
  const src = inlineSource(resolve(rootDir, 'lib/grouping.mjs'));
  const regionsJson = JSON.stringify(regions, null, 2);

  const written = [];

  // 节点清理脚本：排除正则来自 config/node-filter.yaml
  const filterCfg = parse(readFileSync(resolve(rootDir, 'config/node-filter.yaml'), 'utf8'));
  const excludeRegex = filterCfg.exclude_regex;
  if (typeof excludeRegex !== 'string' || excludeRegex === '') {
    throw new Error('config/node-filter.yaml 缺少 exclude_regex');
  }
  const nodesTpl = readFileSync(resolve(rootDir, 'templates/script-nodes.js.tpl'), 'utf8');
  writeFileSync(
    join(dir, 'nodes.js'),
    nodesTpl.replace('__EXCLUDE_REGEX__', () => `new RegExp(${JSON.stringify(excludeRegex)})`),
  );
  written.push('scripts/nodes.js');

  for (const name of ['singbox', 'mihomo']) {
    const tpl = readFileSync(resolve(rootDir, `templates/script-${name}.js.tpl`), 'utf8');
    // 用函数形式替换：字符串形式会把源码里的 `$'`/`$&` 当成替换模式
    const code = tpl
      .replace('__REGIONS_JSON__', () => regionsJson)
      .replace('__GROUPING_SRC__', () => src);
    if (code.includes('export ') || code.includes('import ')) {
      throw new Error(`${name} 脚本产物仍含 import/export，Sub-Store 无法直接执行`);
    }
    writeFileSync(join(dir, `${name}.js`), code);
    written.push(`scripts/${name}.js`);
  }
  return written;
}
