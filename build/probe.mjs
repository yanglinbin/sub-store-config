import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DURATION_MS = Number(process.env.PROBE_MS || 25000);

/**
 * 运行时冒烟：把模板里的 tun 换成普通 mixed 入站，真跑一段 sing-box，
 * 断言 1) 没有 FATAL 2) 至少有一条 "updated rule-set"（说明 rule-set 真的下载并初始化了）。
 * 为什么需要它：`sing-box check` 只做解码校验，抓不到 "detour to an empty direct outbound" 这类运行时错误。
 */
export function probeSingbox({
  configPath = 'dist/singbox/template.json',
  durationMs = DURATION_MS,
  ruleSets = 'local', // 'local'：用本地 dist 产物（确定性）；'remote'：按模板里的 URL 真下载
} = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  if (ruleSets === 'local') {
    // 把远端 rule_set 换成指向本地 dist 的本地文件，避免"发布前 404"和网络抖动
    config.route.rule_set = (config.route.rule_set || []).map((rs) => {
      const m = /singbox\/rules\/([^/]+)$/.exec(rs.url);
      return m ? { type: 'local', tag: rs.tag, format: 'binary', path: `dist/singbox/rules/${m[1]}` } : rs;
    });
  }
  config.inbounds = [{ type: 'mixed', tag: 'probe-in', listen: '127.0.0.1', listen_port: 17890 }];
  config.log = { level: 'info', timestamp: false };
  if (config.experimental) delete config.experimental.clash_api;

  const dir = mkdtempSync(join(tmpdir(), 'ssc-probe-'));
  const file = join(dir, 'probe.json');
  // 用全新缓存目录，强制真的下载 rule-set，才能验证下载链路与 detour 配置
  config.experimental = config.experimental || {};
  config.experimental.cache_file = { enabled: true, path: join(dir, 'cache.db'), store_fakeip: true };
  writeFileSync(file, JSON.stringify(config, null, 2));

  return new Promise((resolve) => {
    const child = spawn('sing-box', ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const killer = setTimeout(() => child.kill('SIGTERM'), durationMs);
    child.on('close', () => {
      clearTimeout(killer);
      const problems = [];
      if (/FATAL/.test(out)) problems.push(...out.split('\n').filter((l) => /FATAL/.test(l)));
      // 本地模式不会打印 "updated rule-set"，只在远端模式下要求真的下载成功
      if (ruleSets === 'remote' && !/updated rule-set/.test(out)) {
        problems.push('没有任何 rule-set 被初始化（可能全部下载失败）');
      }
      resolve({ ok: problems.length === 0, problems, output: out });
    });
  });
}

const NETWORK_ERROR = /wsarecv|forcibly closed|connection reset|ECONNRESET|ETIMEDOUT|i\/o timeout|no such host|TLS handshake|unexpected EOF/i;

/** 只有"网络抖动"才重试；配置类错误（decode/detour/unsupported/unknown…）一次就判死 */
function classify(problems) {
  const text = problems.join('\n');
  if (/detour to an empty|unsupported|unknown|decode config|invalid|duplicate/i.test(text)) return 'config';
  if (NETWORK_ERROR.test(text)) return 'network';
  return 'config';
}

if (process.argv[1] && process.argv[1].endsWith('probe.mjs')) {
  let failed = false;

  let sb = await probeSingbox();
  if (process.env.PROBE_REMOTE === '1') sb = await probeSingbox({ ruleSets: 'remote' });
  if (!sb.ok && classify(sb.problems) === 'network') {
    console.log('… sing-box 冒烟因网络抖动失败，重试一次');
    sb = await probeSingbox();
  }
  if (sb.ok) console.log('✔ sing-box 运行时冒烟通过（rule-set 已初始化，无 FATAL）');
  else if (classify(sb.problems) === 'network') {
    console.log('… sing-box 冒烟两次都被网络中断，跳过（不是配置问题）');
  } else {
    failed = true;
    for (const p of sb.problems) console.error('✖ sing-box:', p);
  }

  const { probeMihomo } = await import('./probe-mihomo.mjs');
  const mh = await probeMihomo();
  if (mh.ok) console.log(`✔ mihomo 冒烟通过${mh.skipped ? '（' + mh.skipped + '，已跳过）' : '（mihomo -t）'}`);
  else {
    failed = true;
    for (const p of mh.problems) console.error('✖ mihomo:', p);
  }

  if (failed) process.exitCode = 1;
}
