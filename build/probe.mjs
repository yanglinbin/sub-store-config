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
export function probeSingbox({ configPath = 'dist/singbox/template.json', durationMs = DURATION_MS } = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
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
      if (!/updated rule-set/.test(out)) problems.push('没有任何 rule-set 被初始化（可能全部下载失败）');
      resolve({ ok: problems.length === 0, problems, output: out });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('probe.mjs')) {
  const r = await probeSingbox();
  if (r.ok) {
    console.log('✔ 运行时冒烟通过（rule-set 已初始化，无 FATAL）');
  } else {
    for (const p of r.problems) console.error('✖', p);
    process.exitCode = 1;
  }
}
