#!/usr/bin/env node
/**
 * standalone 产物补齐:Next standalone 不包含 public/ 与 .next/static,
 * 需拷入 .next/standalone 供打包(server 以 standalone 目录为 cwd 提供静态资源)。
 */
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');

for (const [from, to] of [
  [path.join(root, 'public'), path.join(standalone, 'public')],
  [path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static')],
]) {
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, to, { recursive: true });
  console.log(`[copy-standalone] ✓ ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

// 防御:根目录 news_archive.db 会被 Next 追踪进 standalone,打包产物绝不能携带
// 开发机/CI 的真实数据。用户数据运行时由主进程经 NEWS_DB_PATH 指向 userData。
const strayDbs = ['news_archive.db', 'news_archive.db-wal', 'news_archive.db-shm'];
for (const name of strayDbs) {
  const p = path.join(standalone, name);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    console.log(`[copy-standalone] ✗ removed stray ${name} from standalone`);
  }
}
