import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { geoipMrs, metaMrs } from './upstream.mjs';

const TPL = 'templates/mihomo.yaml.tpl';

const TARGET_NAME = { reject: 'REJECT', direct: 'direct', proxies: 'proxies', f1tv: 'f1tv' };

/** 渲染 mihomo 完整配置：模板固定字段 + order 派生的 rule-providers / rules + 兜底组。 */
export function renderMihomo({ regions, order, modules, baseUrl, rootDir = process.cwd() }) {
  const tpl = readFileSync(resolve(rootDir, TPL), 'utf8');

  const ruleProviders = {};
  for (const { module } of order) {
    const mod = modules[module];
    if (mod.kind === 'remote') {
      // 官方预编译产物：mihomo 用 .mrs（geoip 与 meta 两个上游都是这个格式）
      const url = mod.upstream === 'meta' ? metaMrs(mod.layer, mod.category) : geoipMrs(mod.category);
      ruleProviders[module] = {
        type: 'http',
        behavior: mod.behavior,
        format: 'mrs',
        url,
        path: `./mrs/${mod.upstream === 'meta' ? mod.layer : 'geoip'}/${mod.category}.mrs`,
        interval: 86400,
      };
      continue;
    }
    ruleProviders[module] = {
      type: 'http',
      behavior: mod.behavior,
      format: 'yaml',
      url: `${baseUrl}/mihomo/rules/${module}.list`,
      path: `./ruleset/${module}.yaml`,
      interval: 86400,
    };
  }

  const rules = order.map(({ module, target, no_resolve }) => {
    const parts = ['RULE-SET', module, TARGET_NAME[target]];
    if (no_resolve) parts.push('no-resolve');
    return parts.join(',');
  });

  const fallbackGroups = ['proxies', 'f1tv', 'direct', 'final'].map((name) => ({
    name,
    type: 'select',
    proxies: ['DIRECT'],
  }));

  const body = tpl
    .replace('{{RULE_PROVIDERS}}', JSON.stringify(ruleProviders))
    .replace('{{RULES}}', JSON.stringify(rules))
    .replace('{{PROXY_GROUPS_FALLBACK}}', JSON.stringify(fallbackGroups));

  const config = parse(body);
  if (!config || typeof config !== 'object') throw new Error('mihomo 模板渲染结果非法');
  return stringify(config, { lineWidth: 0 });
}
