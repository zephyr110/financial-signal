import fs from 'fs';
import { getDb } from '../../lib/db';
import { getPipelineHealth } from '../../lib/pipeline';

/**
 * P1.7 健康探活端点（公开，无 auth——供 UptimeRobot / Uptime Kuma 等外部探活服务轮询）。
 *
 * GET /api/health
 * - DB 不可达 → 503 { ok: false }
 * - DB 正常 → 200 { ok: true, db, pipeline: <24h 各段聚合> }
 *
 * 外部探活配置：监控 https://<APP_URL>/api/health，期望 HTTP 200。
 */
export default async function handler(req, res) {
  // 探活端点接受 HEAD/GET；其他方法一律 405（不消耗 DB 连接）
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const startedAt = Date.now();

  // 0. 本地文件模式(db 文件缺失 = 桌面端首启,库尚未创建):跳过 getDb,
  // 避免健康检查抢先建库——否则渲染层 getInfo 的 imported 恒 true,
  // 首次引导欢迎页永不出现。返回 200(db 未初始化,但进程活着),
  // waitForHealthy 只看状态码,serverManager.start() 照常通过。
  // Turso/Vercel 模式无文件概念,该检查自然跳过,行为不变。
  // :memory: 模式不产生文件,同样跳过(保持现有"报告 ok"行为)。
  const localDbPath = process.env.NEWS_DB_PATH;
  if (
    !process.env.TURSO_DATABASE_URL
    && localDbPath && !localDbPath.startsWith(':')
    && !fs.existsSync(localDbPath)
  ) {
    const payload = {
      ok: true,
      db: 'missing',
      pipeline: null,
      latency_ms: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    };
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  }

  // 1. DB 连通性
  let dbOk = true;
  let dbError: string | null = null;
  try {
    const db = await getDb();
    await db.execute({ sql: 'SELECT 1', args: [] });
  } catch (err) {
    dbOk = false;
    dbError = err instanceof Error ? err.message : String(err);
  }

  // 2. 管线 24h 聚合（DB 挂了就不查）
  let pipeline = null;
  if (dbOk) {
    try {
      pipeline = await getPipelineHealth(24);
    } catch (err) {
      dbOk = false;
      dbError = `pipeline aggregation failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const payload = {
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    db_error: dbError,
    pipeline,
    latency_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };

  // 探活服务以状态码判断健康：正常 200，异常 503
  res.setHeader('Cache-Control', 'no-store');
  if (!dbOk) return res.status(503).json(payload);
  return res.status(200).json(payload);
}
