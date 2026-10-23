import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TPL = 'templates/singbox.json.tpl';

/** 只做模板替换与自检；策略组由 Sub-Store 脚本在运行时重建。 */
export function renderSingbox({ regions, order, modules, baseUrl, rootDir = process.cwd(), format = 'binary', ext = 'srs' }) {
  const tpl = readFileSync(resolve(rootDir, TPL), 'utf8');

  const ruleSet = order.map(({ module }) => ({
    type: 'remote',
    tag: module,
    format,
    url: `${baseUrl}/singbox/rules/${module}.${ext}`,
    update_interval: '1d',
  }));

  const rules = order.map(({ module, target }) =>
    target === 'reject'
      ? { rule_set: module, action: 'reject' }
      : { rule_set: module, action: 'route', outbound: target },
  );

  const body = tpl
    .replace('{{RULE_SET}}', JSON.stringify(ruleSet))
    .replace('{{RULES}}', JSON.stringify(rules));

  let config;
  try {
    config = JSON.parse(body);
  } catch (err) {
    throw new Error(`sing-box 模板渲染后不是合法 JSON: ${err.message}`);
  }
  return JSON.stringify(config, null, 2) + '\n';
}
