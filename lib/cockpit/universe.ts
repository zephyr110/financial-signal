import { getDb } from '../db'

/** 研究池上限：免费源逐只拉日线的成本上限，同时也是投研台行业聚合的关注范围。 */
export const MAX_UNIVERSE_CODES = 60

/**
 * 研究池：自选 ∪ 非演示账户的持仓（shares > 0）。
 * 免费源入库、AKShare 补数、投研台空态判断共用同一口径，避免各处 SQL 漂移。
 */
export async function researchCodes(limit: number = MAX_UNIVERSE_CODES): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT code FROM (
            SELECT code FROM watchlist_items
            UNION
            SELECT code FROM positions
            WHERE account_id <> 'demo-account' AND shares > 0
          ) ORDER BY code LIMIT ?`,
    args: [limit],
  })
  return res.rows.map((row) => (row.code == null ? '' : String(row.code))).filter(Boolean)
}
