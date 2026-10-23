import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';

const TPL = 'templates/mihomo.yaml.tpl';

const TARGET_NAME = { reject: 'REJECT', direct: 'direct', proxies: 'proxies', f1tv: 'f1tv' };

/** 渲染 mihomo 完整配置：模板固定字段 + order 派生的 rule-providers / rules + 兜底组。 */
export function renderMihomo({ regions, order, modules, baseUrl, rootDir = process.cwd() }) {
  const tpl = readFileSync(resolve(rootDir, TPL), 'utf8');

  const ruleProviders = {};
  for (const { module } of order) {
    ruleProviders[module] = {
      type: 'http',
      behavior: modules[module].behavior,
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

  const fallbackGroups = ['proxies', 'direct', 'f1tv', 'final'].map((name) => ({
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
