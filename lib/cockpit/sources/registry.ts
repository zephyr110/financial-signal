import { getDb } from '../../db'

/**
 * 真实来源在空库里也要有登记行（示例种子只在 COCKPIT_DEMO 下跑）。
 * 统一用 INSERT OR IGNORE：示例种子的元数据优先，避免互相覆盖。
 */
const SOURCE_SEEDS = [
  { id: 'sse', name: '上海证券交易所', tier: 0, kind: 'exchange', base_url: 'https://www.sse.com.cn' },
  { id: 'cninfo', name: '巨潮资讯', tier: 0, kind: 'disclosure', base_url: 'https://www.cninfo.com.cn' },
  { id: 'csrc', name: '中国证监会', tier: 0, kind: 'regulator', base_url: 'https://www.csrc.gov.cn' },
  { id: 'tushare', name: 'Tushare Pro', tier: 1, kind: 'market', base_url: 'https://tushare.pro' },
  { id: 'akshare', name: 'AKShare（东财等公开接口）', tier: 2, kind: 'market', base_url: 'https://akshare.akfamily.xyz' },
] as const

export async function ensureCockpitSources(): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  for (const source of SOURCE_SEEDS) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO source_registry
            (id, name, tier, kind, base_url, terms_url, enabled, last_success_at, last_error,
             consecutive_failures, is_demo, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 0, 0, ?)`,
      args: [source.id, source.name, source.tier, source.kind, source.base_url, now],
    })
  }
}

export async function markSourceSuccess(id: string, at = new Date().toISOString()): Promise<void> {
  const db = await getDb()
  await db.execute({
    sql: `UPDATE source_registry SET enabled = 1, last_success_at = ?, last_error = NULL,
          consecutive_failures = 0 WHERE id = ?`,
    args: [at, id],
  })
}

export async function markSourceFailure(id: string, message: string): Promise<void> {
  const db = await getDb()
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT OR IGNORE INTO source_registry
          (id, name, tier, kind, base_url, terms_url, enabled, last_success_at, last_error,
           consecutive_failures, is_demo, created_at)
          VALUES (?, ?, 2, 'unknown', NULL, NULL, 1, NULL, ?, 1, 0, ?)`,
    args: [id, id, message.slice(0, 300), now],
  })
  await db.execute({
    sql: `UPDATE source_registry SET enabled = 1, last_error = ?,
          consecutive_failures = consecutive_failures + 1 WHERE id = ?`,
    args: [message.slice(0, 300), id],
  })
}

/**
 * 示例与真实数据禁止同库混用：一旦检测到示例行情/概览/公告，接入真实源就直接失败，
 * 让人明确换库，而不是悄悄用示例数字补洞。
 */
export async function assertNoDemoData(): Promise<void> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT
            (SELECT COUNT(*) FROM market_bars WHERE is_demo = 1) AS bars,
            (SELECT COUNT(*) FROM market_overview WHERE is_demo = 1) AS overviews,
            (SELECT COUNT(*) FROM source_documents WHERE is_demo = 1) AS documents,
            (SELECT COUNT(*) FROM limit_pool WHERE is_demo = 1) AS limit_pools`,
    args: [],
  })
  const row = res.rows[0]
  const total = Number(row?.bars || 0) + Number(row?.overviews || 0)
    + Number(row?.documents || 0) + Number(row?.limit_pools || 0)
  if (total > 0) {
    throw new Error('当前数据库含示例行情/公告，真实数据接入已停止；请改用新的数据库后再接入，避免示例与真实数据混用。')
  }
}
