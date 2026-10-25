import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { geoipSrs } from './upstream.mjs';

const TPL = 'templates/singbox.json.tpl';

/** 只做模板替换与自检；策略组由 Sub-Store 脚本在运行时重建。 */
export function renderSingbox({
  regions,
  order,
  modules,
  baseUrl,
  rootDir = process.cwd(),
  format = 'binary',
  ext = 'srs',
}) {
  const tpl = readFileSync(resolve(rootDir, TPL), 'utf8');

  const ruleSet = order.map(({ module }) => {
    const mod = modules[module];
    if (mod.kind === 'remote') {
      // 官方预编译产物：sing-box 用 .srs
      return {
        type: 'remote',
        tag: module,
        format: 'binary',
        url: geoipSrs(mod.category),
        update_interval: '1d',
      };
    }
    return {
      type: 'remote',
      tag: module,
      format,
      url: `${baseUrl}/singbox/rules/${module}.${ext}`,
      update_interval: '1d',
    };
  });

  // 配置级前置动作（不随 order 变化）：
  //   sniff      → 从连接里识别域名/协议
  //   hijack-dns → 把发往 53 端口的 DNS 拉进 sing-box 自己的 DNS
  const rules = [{ action: 'sniff' }, { action: 'hijack-dns', protocol: 'dns' }];
  let resolveInserted = false;
  for (const { module, target } of order) {
    const mod = modules[module];
    // 域名类规则靠域名匹配即可；IP 类规则必须先把域名解析成真实 IP，
    // 否则 fakeip 模式下目标地址是 198.18.x，geoip 规则永远不命中
    if (!resolveInserted && mod.behavior === 'ipcidr') {
      rules.push({ action: 'resolve', server: 'local-dns' });
      resolveInserted = true;
    }
    rules.push(
      target === 'reject'
        ? { rule_set: module, action: 'reject' }
        : { rule_set: module, action: 'route', outbound: target },
    );
  }

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
