import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFetcher } from '../build/fetch.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'ssc-fetch-'));

test('首次下载并落盘，第二次走缓存不再请求', async () => {
  const cacheDir = dir();
  let calls = 0;
  const f = createFetcher({
    cacheDir,
    fetchImpl: async () => {
      calls++;
      return { ok: true, text: async () => 'DOMAIN,a.com' };
    },
  });
  assert.equal(await f.get('https://x/a.txt'), 'DOMAIN,a.com');
  assert.equal(await f.get('https://x/a.txt'), 'DOMAIN,a.com');
  assert.equal(calls, 1);
  assert.equal(readdirSync(cacheDir).length, 1);
});

test('下载失败但已有缓存时用缓存并告警', async () => {
  const cacheDir = dir();
  const warn = [];
  const ok = createFetcher({
    cacheDir,
    fetchImpl: async () => ({ ok: true, text: async () => 'cached' }),
  });
  await ok.get('https://x/b.txt');
  const bad = createFetcher({
    cacheDir,
    onWarn: (u, e) => warn.push(u),
    fetchImpl: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(await bad.get('https://x/b.txt'), 'cached');
  assert.equal(warn.length, 1);
});

test('下载失败且无缓存时抛错', async () => {
  const f = createFetcher({
    cacheDir: dir(),
    fetchImpl: async () => {
      throw new Error('boom');
    },
  });
  await assert.rejects(() => f.get('https://x/c.txt'), /boom/);
});

test('HTTP 非 2xx 视为失败', async () => {
  const f = createFetcher({
    cacheDir: dir(),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
  });
  await assert.rejects(() => f.get('https://x/d.txt'), /404/);
});
