import { getDb } from '../db'

export interface PersonalIndustrySets {
  holdings: Set<string>
  watchlist: Set<string>
}

async function industrySet(codeQuery: string): Promise<Set<string>> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT s.industry_l1 AS industry
          FROM symbols s
          WHERE s.industry_l1 IS NOT NULL AND s.industry_l1 <> '' AND s.industry_l1 <> '指数'
            AND s.code IN (${codeQuery})`,
    args: [],
  })
  return new Set(
    (res.rows as unknown as Record<string, unknown>[])
      .map((row) => String(row.industry || ''))
      .filter(Boolean),
  )
}

/** 持仓与自选所在的行业：行业判断置顶展示，也决定预警覆盖范围。 */
export async function personalIndustrySets(): Promise<PersonalIndustrySets> {
  const [holdings, watchlist] = await Promise.all([
    industrySet('SELECT code FROM positions WHERE shares > 0'),
    industrySet('SELECT code FROM watchlist_items'),
  ])
  return { holdings, watchlist }
}

export async function personalIndustrySet(): Promise<Set<string>> {
  const { holdings, watchlist } = await personalIndustrySets()
  return new Set([...holdings, ...watchlist])
}
