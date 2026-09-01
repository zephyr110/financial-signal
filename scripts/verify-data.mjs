#!/usr/bin/env node
/**
 * P1.5 构建期 DB 预检：在 next build 之前验证数据层连通性。
 *
 * 目的：构建期 getStaticPaths/getStaticProps 会访问 DB——若 DB 不可达/缺表，
 * prerender 错误会让整个 Vercel build 失败，且错误信息深埋在 next build 日志里。
 * 本脚本在 build 前快速探测，给出清晰的可操作报错。
 *
 * 用法：node scripts/verify-data.mjs （由 package.json "prebuild" 自动执行）
 * 退出码：0 = 通过，或 DB 不可达但已降级警告（不阻止 build）；
 *         1 = VERIFY_DATA_STRICT=1 且 DB 不可达/关键表缺失（阻止 build）。
 * 降级原因：pages 下的 getStaticPaths 已对 DB 不可达优雅退化（try/catch → 空路径 +
 * blocking fallback），next build 本身不需要 DB；prebuild 硬失败会让整个部署
 * 死于 DB 不可达（如 Turso 免费额度用尽/未配置），与解耦设计矛盾。
 * 需要强制校验 DB 的部署流程设 VERIFY_DATA_STRICT=1。
 */
import { createClient } from '@libsql/client';

const STRICT = process.env.VERIFY_DATA_STRICT === '1';

// DB 问题统一降级：默认警告不阻断构建；严格模式（VERIFY_DATA_STRICT=1）才 exit 1。
function dbProblem(reason, hint) {
  console.warn(`[verify-data] ⚠ ${reason}`);
  console.warn(`[verify-data]   ${hint}`);
  console.warn(
    '[verify-data]   构建继续:pages 的 getStaticPaths 已对 DB 不可达退化(空路径 + blocking fallback)。'
  );
  if (STRICT) {
    console.error('[verify-data] ✗ 严格模式(VERIFY_DATA_STRICT=1)下视为失败');
    process.exit(1);
  }
  process.exit(0);
}

// 与 lib/db.ts resolveClientConfig 保持一致的连接解析
function resolveClientConfig() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) {
    return { url, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  if (process.env.VERCEL) {
    throw new Error(
      'TURSO_DATABASE_URL is required on Vercel. Create a Turso DB and set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.'
    );
  }
  const filePath = process.env.NEWS_DB_PATH || 'news_archive.db';
  return { url: `file:${filePath}` };
}

const REQUIRED_TABLES = [
  'news_archive',
  'analysis_result',
  'event_threads',
  'market_data',
  'backtest_result',
  'pipeline_run',
  'pipeline_cursor',
];

async function main() {
  const client = createClient(resolveClientConfig());

  // 1. 连通性
  try {
    await client.execute({ sql: 'SELECT 1', args: [] });
  } catch (err) {
    dbProblem(
      `无法连接数据库: ${err.message}`,
      '检查 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 是否配置且可达(如 Turso 免费额度用尽)。'
    );
  }
  console.log('[verify-data] ✓ 数据库连接正常');

  // 2. 关键表
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    try {
      const r = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [table],
      });
      if (r.rows.length === 0) missing.push(table);
    } catch (err) {
      missing.push(`${table} (查询失败: ${err.message})`);
    }
  }
  if (missing.length > 0) {
    dbProblem(
      `缺失关键表: ${missing.join(', ')}`,
      '首次部署需先建库;确认 DB 指向了正确的 Turso 实例。'
    );
  }
  console.log(`[verify-data] ✓ ${REQUIRED_TABLES.length} 张关键表齐全`);

  // 3. 数据量简报（信息性；空库合法——管线会逐步填充）
  const counts = {};
  for (const table of REQUIRED_TABLES) {
    try {
      const r = await client.execute({ sql: `SELECT COUNT(*) AS n FROM ${table}`, args: [] });
      counts[table] = Number(r.rows[0].n);
    } catch {
      counts[table] = '?';
    }
  }
  console.log(
    '[verify-data] 数据量: ' +
      Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(' ')
  );

  console.log('[verify-data] ✓ 预检通过');
  process.exit(0);
}

main().catch((err) => {
  // 覆盖 resolveClientConfig 抛错(如 Vercel 上未配置 TURSO_DATABASE_URL)等同步路径
  dbProblem(`预检异常: ${err.message}`, '检查 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 配置。');
});
