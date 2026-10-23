import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from './load.mjs';
import { createFetcher } from './fetch.mjs';
import { writeRuleSets } from './rulesets.mjs';
import { renderMihomo } from './render-mihomo.mjs';
import { renderSingbox } from './render-singbox.mjs';
import { emitScripts } from './emit-script.mjs';
import { validateDist } from './validate.mjs';

const BASE_URL = process.env.BASE_URL || 'https://raw.githubusercontent.com/yanglinbin/sub-store-config/dist';
const DIST = 'dist';

const { regions, modules, order } = loadAll();
const fetcher = createFetcher({
  cacheDir: '.cache',
  onWarn: (url, err) => console.warn(`[warn] 上游拉取失败，使用缓存: ${url} (${err.message})`),
});

mkdirSync(join(DIST, 'mihomo'), { recursive: true });
mkdirSync(join(DIST, 'singbox'), { recursive: true });

const rulesetFiles = await writeRuleSets({ modules, order, distDir: DIST, fetcher });
console.log(`[1/4] 规则集 ${rulesetFiles.length} 个文件`);

writeFileSync(join(DIST, 'mihomo/config.yaml'), renderMihomo({ regions, order, modules, baseUrl: BASE_URL }));
writeFileSync(join(DIST, 'singbox/template.json'), renderSingbox({ regions, order, modules, baseUrl: BASE_URL }));
console.log('[2/4] 两端模板已渲染');

const scripts = await emitScripts({ outDir: join(DIST, 'scripts') });
console.log(`[3/4] 脚本 ${scripts.length} 个`);

const ruleCount = rulesetFiles.length / 2;
writeFileSync(
  join(DIST, 'build-info.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), baseUrl: BASE_URL, counts: { modules: order.length, rules: ruleCount, files: rulesetFiles.length } }, null, 2) + '\n',
);

const result = await validateDist({ distDir: DIST, baseUrl: BASE_URL });
if (!result.ok) {
  for (const p of result.problems) console.error('✖', p);
  process.exitCode = 1;
} else {
  console.log(`[4/4] 校验通过（${order.length} 模块）`);
}
