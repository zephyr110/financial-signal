import { getDb, pruneEventLog } from '../../lib/db';

/**
 * P2.1 埋点接收端点：批量写入 event_log。
 * POST /api/events  { events: [{ name, payload, ts, session }] }
 *
 * 设计：
 * - 事件名白名单（P2.1 五个事件；后续扩展在此登记）
 * - payload 内嵌 ts/session 后整体 JSON 化存 payload 列（事件结构自描述，
 *   查询按 payload 字段展开，不新增列）
 * - 单条失败不阻断整批；端点无状态，重复投递由幂等性不敏感（计数事件，可容忍少量重复）
 * - 批量多值 INSERT（每批 50 行），替代逐条往返
 * - 写路径上每小时至多触发一次旧数据清理（append-only 表的保留策略）
 */
const ALLOWED_EVENT_NAMES = new Set([
  'signal_click',
  'thread_expand',
  'industry_drill',
  'watchlist_add',
  'watchlist_remove',
  'search_query',
]);

/** 清理节流：每小时至多一次。 */
let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return res.status(400).json({ ok: false, error: 'events must be a non-empty array (≤100)' });
  }

  // 组装合法行（过滤未知事件名），单条构造失败跳过
  const rows = [];
  for (const e of events) {
    if (!e || typeof e.name !== 'string' || !ALLOWED_EVENT_NAMES.has(e.name)) continue;
    const entityId =
      e.entityId != null && Number.isFinite(Number(e.entityId)) ? Number(e.entityId) : null;
    const payload = {
      ...(e.payload && typeof e.payload === 'object' ? e.payload : {}),
      ts: typeof e.ts === 'string' ? e.ts : new Date().toISOString(),
      session: typeof e.session === 'string' ? e.session : null,
    };
    rows.push([e.name, entityId, JSON.stringify(payload)]);
  }

  let accepted = 0;
  if (rows.length > 0) {
    const db = await getDb();
    // 批量多值 INSERT（SQLite 单语句参数上限 ~500，每批 50 行 × 3 列 = 150 参数）
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const values = batch.map(() => '(?, ?, ?)').join(', ');
      const args = batch.flat();
      try {
        const r = await db.execute({
          sql: `INSERT INTO event_log (event_type, entity_id, payload) VALUES ${values}`,
          args,
        });
        accepted += r.rowsAffected || 0;
      } catch (err) {
        // 整批失败时降级逐条（保留"单条失败不阻断整批"的既有语义）
        console.error('[events] batch insert failed, falling back:', err.message);
        for (const [name, entityId, payload] of batch) {
          try {
            const r = await db.execute({
              sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
              args: [name, entityId, payload],
            });
            accepted += r.rowsAffected || 0;
          } catch (e2) {
            console.error('[events] insert failed:', e2.message);
          }
        }
      }
    }
  }

  // 保留策略：写路径上每小时至多清理一次，失败不阻断
  const now = Date.now();
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    void pruneEventLog(90);
  }

  res.status(200).json({ ok: true, accepted });
}
