import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { geoipSrs } from './upstream.mjs';

const TPL = 'templates/singbox.json.tpl';

const LOCAL_DNS = 'local-dns';
const REMOTE_DNS = 'remote-dns';
const FAKEIP_DNS = 'fakeip';
/** 远端 evaluate 的响应标签，供后面的 match_response / respond 引用 */
const REMOTE_ANSWER = 'remote-answer';
/** 本地 DNS 的 evaluate 超时：超时就当本地没答上来，直接走远端 */
const LOCAL_EVAL_TIMEOUT = '2s';
const LAN_SUFFIXES = ['.lan', '.local', '.direct', '.localhost'];
/** NTP 白名单：用后缀匹配（domain_keyword ["time"] 会误伤 timesofindia 之类） */
const NTP_HOSTS = [
  'time.windows.com',
  'time.apple.com',
  'time.nist.gov',
  'pool.ntp.org',
  'ntp.aliyun.com',
  'ntp.tencent.com',
];

/** order 里 target=direct 的 IP 规则集（lancidr / cncidr），用于判断本地 DNS 答的是不是国内 IP */
export function domesticIpModules({ order, modules }) {
  return order
    .filter(({ module, target }) => target === 'direct' && modules[module]?.behavior === 'ipcidr')
    .map(({ module }) => module);
}

/**
 * DNS 分流规则（顺序即语义）：
 *   1. 内网域名 / NTP → 本地
 *   2. 域名类模块按 target 分派：direct → 本地真实解析（直连本来就要真实 IP，省掉后续一次 resolve）；
 *      其余 → fakeip（解析交给出口侧，零等待、零泄露）
 *   3. 其余查询类型（HTTPS/SVCB 等）→ 远端：本地 DNS 对国外域名只会给出 CN 视角的答案
 *   4. 未命中任何域名表的 A/AAAA：本地与远端并发（evaluate 不阻塞），
 *      本地答案是 CN/内网 IP 就 race 抢先用（快），否则等远端那份（准）
 */
export function buildDnsRules({ order, modules }) {
  const rules = [
    { domain_suffix: LAN_SUFFIXES, action: 'route', server: LOCAL_DNS },
    { domain_suffix: NTP_HOSTS, action: 'route', server: LOCAL_DNS },
  ];

  for (const { module, target } of order) {
    if (modules[module].behavior !== 'domain') continue;
    rules.push(
      target === 'direct'
        ? { rule_set: [module], action: 'route', server: LOCAL_DNS }
        : { rule_set: [module], query_type: ['A', 'AAAA'], action: 'route', server: FAKEIP_DNS },
    );
  }

  rules.push({ query_type: ['A', 'AAAA'], invert: true, action: 'route', server: REMOTE_DNS });

  // 未命中任何域名表：两条查询并行发出（evaluate 本身不阻塞规则匹配）
  // 本地那条给 2s 超时：它是“快”的一路，拖长了只会把后面等它的远端答案一起拖下去
  rules.push(
    { action: 'evaluate', server: LOCAL_DNS, timeout: LOCAL_EVAL_TIMEOUT },
    { action: 'evaluate', server: REMOTE_DNS, tag: REMOTE_ANSWER },
  );
  const domesticIps = domesticIpModules({ order, modules });
  if (domesticIps.length > 0) {
    rules.push({ match_response: true, race: true, rule_set: domesticIps, action: 'respond' });
  }
  rules.push({ match_response: REMOTE_ANSWER, action: 'respond' });

  return rules;
}

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
    .replace('{{DNS_RULES}}', JSON.stringify(buildDnsRules({ order, modules })))
    .replace('{{RULES}}', JSON.stringify(rules));

  let config;
  try {
    config = JSON.parse(body);
  } catch (err) {
    throw new Error(`sing-box 模板渲染后不是合法 JSON: ${err.message}`);
  }
  return JSON.stringify(config, null, 2) + '\n';
}
