import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 上游抓取 + 磁盘缓存。
 * 语义：**每次构建都尝试拉最新**（否则上游永远不更新），磁盘缓存是"拉不到时的兜底"；
 * 同一次构建内重复读取同一 URL 用内存 memo，避免重复下载。
 */
export function createFetcher({
  cacheDir,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  onWarn = () => {},
} = {}) {
  if (!cacheDir) throw new Error('createFetcher 需要 cacheDir');
  mkdirSync(cacheDir, { recursive: true });

  const pathOf = (url) =>
    join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16) + '.txt');
  const memo = new Map();

  return {
    async get(url) {
      if (memo.has(url)) return memo.get(url);

      const file = pathOf(url);
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        const text = await res.text();
        writeFileSync(file, text);
        memo.set(url, text);
        return text;
      } catch (err) {
        if (existsSync(file)) {
          onWarn(url, err);
          const cached = readFileSync(file, 'utf8');
          memo.set(url, cached);
          return cached;
        }
        throw err;
      }
    },
  };
}
