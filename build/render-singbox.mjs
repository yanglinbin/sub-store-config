import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { geoipSrs } from './upstream.mjs';

const TPL = 'templates/singbox.json.tpl';

const LOCAL_DNS = 'local-dns';
/** 国内第二路 DNS（DNSPod DoH）：与阿里云竞速，任一台慢/挂掉都会被绕过 */
const LOCAL_DNS_2 = 'local-dns-2';
const REMOTE_DNS = 'remote-dns';
/** 境外第二路 DNS（Google TLS），与 Cloudflare 竞速 */
const REMOTE_DNS_2 = 'remote-dns-2';
const FAKEIP_DNS = 'fakeip';
/** 远端 evaluate 的响应标签，供后面的 match_response / respond 引用 */
const REMOTE_ANSWER = 'remote-answer';
const REMOTE_ANSWER_2 = 'remote-answer-2';
/** 本地 DNS 的 evaluate 超时：超时就当本地没答上来，直接走远端 */
const LOCAL_EVAL_TIMEOUT = '2s';
/** direct 域名的主 DNS 超时：正常 20~50ms 就回，1s 还没答说明这台有问题，直接换备用 */
const DIRECT_EVAL_TIMEOUT = '1s';
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
 *   2. AAAA 一律空回答：网络没有可用 IPv6 时，拿到 AAAA 只会先赔一次
 *      “network is unreachable” 的死等再回退 v4
 *   3. HTTPS/SVCB 一律空回答：CDN 在这条记录里塞 ipv4hint/ipv6hint，会把客户端
 *      直接引到境外或劣质边缘（并绕过 fakeip 的域名分流），客户端拿不到就回退 A/AAAA
 *   4. 域名类模块按 target 分派：direct → 本地真实解析（直连本来就要真实 IP，省掉后续一次
 *      resolve），先问阿里，`DIRECT_EVAL_TIMEOUT` 内没答就换 DNSPod；其余 → fakeip（解析交给出口侧）
 *   5. 其余查询类型（TXT/SRV 等）→ 本地：跨洋问没有意义
 *   6. 未命中任何域名表的 A/AAAA：本地 + 境外两路并发（evaluate 不阻塞），
 *      本地答案是 CN/内网 IP 就 race 抢先用（快），否则等远端那份（准）
 */
export function buildDnsRules({ order, modules }) {
  const rules = [
    { domain_suffix: LAN_SUFFIXES, action: 'route', server: LOCAL_DNS },
    { domain_suffix: NTP_HOSTS, action: 'route', server: LOCAL_DNS },
    { query_type: ['AAAA'], action: 'predefined', rcode: 'NOERROR' },
    { query_type: ['HTTPS', 'SVCB'], action: 'predefined', rcode: 'NOERROR' },
  ];

  for (const { module, target } of order) {
    if (modules[module].behavior !== 'domain') continue;
    if (target === 'direct') {
      // 先问阿里，超时就换 DNSPod：两台不能同时 evaluate——匿名 evaluate 的结果会被后一条覆盖
      // （启动日志会告警 “evaluated response is overwritten”），只能串成“主 + 兜底”链
      rules.push(
        { rule_set: [module], action: 'evaluate', server: LOCAL_DNS, timeout: DIRECT_EVAL_TIMEOUT },
        { rule_set: [module], match_response: true, action: 'respond' },
        { rule_set: [module], action: 'route', server: LOCAL_DNS_2 },
      );
    } else {
      rules.push({ rule_set: [module], query_type: ['A', 'AAAA'], action: 'route', server: FAKEIP_DNS });
    }
  }

  rules.push({ query_type: ['A', 'AAAA'], invert: true, action: 'route', server: LOCAL_DNS });

  // 未命中任何域名表：两条查询并行发出（evaluate 本身不阻塞规则匹配）
  // 本地那条给 2s 超时：它是“快”的一路，拖长了只会把后面等它的远端答案一起拖下去
  rules.push(
    { action: 'evaluate', server: LOCAL_DNS, timeout: LOCAL_EVAL_TIMEOUT },
    { action: 'evaluate', server: REMOTE_DNS, tag: REMOTE_ANSWER },
    { action: 'evaluate', server: REMOTE_DNS_2, tag: REMOTE_ANSWER_2 },
  );
  const domesticIps = domesticIpModules({ order, modules });
  if (domesticIps.length > 0) {
    rules.push({ match_response: true, race: true, rule_set: domesticIps, action: 'respond' });
  }
  rules.push({ match_response: REMOTE_ANSWER, action: 'respond' });
  rules.push({ match_response: REMOTE_ANSWER_2, action: 'respond' });

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
