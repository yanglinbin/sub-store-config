import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from './load.mjs';
import { createFetcher } from './fetch.mjs';
import { writeRuleSets, countEntries, countEntriesByModule } from './rulesets.mjs';
import { renderMihomo } from './render-mihomo.mjs';
import { renderSingbox } from './render-singbox.mjs';
import { emitScripts } from './emit-script.mjs';
import { compileSrs } from './compile-srs.mjs';
import { validateDist, checkOrderInvariants } from './validate.mjs';

const BASE_URL = process.env.BASE_URL || 'https://cdn.jsdelivr.net/gh/yanglinbin/sub-store-config@dist';
const DIST = 'dist';

const { regions, modules, order } = loadAll();

// 顺序不变量：proxy 必须在 direct 前、derive 必须在其来源前、overrides 必须第一
const invariantProblems = checkOrderInvariants(order, modules);
if (invariantProblems.length > 0) {
  for (const p of invariantProblems) console.error('✖', p);
  process.exit(1);
}
const fetcher = createFetcher({
  cacheDir: '.cache',
  onWarn: (url, err) => console.warn(`[warn] 上游拉取失败，使用缓存: ${url} (${err.message})`),
});

mkdirSync(join(DIST, 'mihomo'), { recursive: true });
mkdirSync(join(DIST, 'singbox'), { recursive: true });

const rulesetFiles = await writeRuleSets({ modules, order, distDir: DIST, fetcher });
console.log(`[1/5] 规则集 ${rulesetFiles.length} 个文件`);

const srsOk = await compileSrs({ distDir: DIST });
if (srsOk) {
  // 模板只引用 .srs；.json 仅用于校验/排障，发布前删掉可把 dist 体积砍掉约 1/3
  for (const f of readdirSync(join(DIST, 'singbox/rules'))) {
    if (f.endsWith('.json')) rmSync(join(DIST, 'singbox/rules', f));
  }
}
console.log(`[2/5] 规则集编译为 .srs: ${srsOk ? '是' : '否（退化为 source json）'}`);

writeFileSync(join(DIST, 'mihomo/config.yaml'), renderMihomo({ regions, order, modules, baseUrl: BASE_URL }));
writeFileSync(
  join(DIST, 'singbox/template.json'),
  renderSingbox({
    regions, order, modules, baseUrl: BASE_URL,
    format: srsOk ? 'binary' : 'source',
    ext: srsOk ? 'srs' : 'json',
  }),
);
console.log('[3/5] 两端模板已渲染');

const scripts = await emitScripts({ outDir: join(DIST, 'scripts') });
console.log(`[4/5] 脚本 ${scripts.length} 个`);

const remoteModules = Object.values(modules).filter((m) => m.kind === 'remote').length;
const derivedModules = Object.values(modules).filter((m) => m.derive).length;
const moduleEntries = countEntriesByModule(DIST);
// inputs 是上游文本指纹（fetch 层记的 sha256），moduleEntries 是每个模块实际落地多少条
writeFileSync(
  join(DIST, 'build-info.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      counts: {
        modules: order.length,
        remoteModules,
        derivedModules,
        builtModules: order.length - remoteModules - derivedModules,
        builtEntries: countEntries(DIST),
        pinnedEntries: moduleEntries['direct-pinned'] ?? 0,
        files: rulesetFiles.length,
      },
      inputs: fetcher.digests,
      moduleEntries,
    },
    null,
    2,
  ) + '\n',
);

const result = await validateDist({ distDir: DIST, baseUrl: BASE_URL });
if (!result.ok) {
  for (const p of result.problems) console.error('✖', p);
  process.exitCode = 1;
} else {
  console.log(`[5/5] 校验通过（${order.length} 模块）`);
}
