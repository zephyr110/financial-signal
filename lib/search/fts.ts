/**
 * FTS5 检索：trigram 分词支持中文连续文本，但不足 3 个字符无法命中。
 * 调用方在短查询或 FTS 不可用时必须回退 LIKE；Turso 新引擎可能没有 FTS5。
 */

type DbLike = {
  execute: (stmt: { sql: string; args?: unknown[] }) => Promise<{ rows: unknown[] }>
}

export interface DocumentSearchRow {
  id: string
  title: string
  source_id: string
  published_at: string
}

const availability = new WeakMap<object, Map<string, boolean>>()

export async function hasFtsTable(db: DbLike, table: string): Promise<boolean> {
  let cache = availability.get(db as object)
  if (!cache) {
    cache = new Map()
    availability.set(db as object, cache)
  }
  const cached = cache.get(table)
  if (cached !== undefined) return cached
  try {
    const res = await db.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      args: [table],
    })
    const ok = res.rows.length > 0
    cache.set(table, ok)
    return ok
  } catch {
    cache.set(table, false)
    return false
  }
}

/** 构造安全 MATCH 表达式；任一 term 少于 3 个字符则返回 null，交给 LIKE。 */
export function ftsMatchQuery(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, '').trim())
    .filter(Boolean)
    .slice(0, 6)
  if (!terms.length || terms.some((term) => [...term].length < 3)) return null
  return terms.map((term) => `"${term}"`).join(' ')
}

export async function searchSourceDocuments(
  db: DbLike,
  query: string,
  opts: { days: number; limit: number },
): Promise<DocumentSearchRow[]> {
  const match = ftsMatchQuery(query)
  if (match && (await hasFtsTable(db, 'docs_fts'))) {
    try {
      const res = await db.execute({
        sql: `SELECT d.id, d.title, d.source_id, d.published_at
              FROM docs_fts
              JOIN source_documents d ON d.id = docs_fts.doc_id
              WHERE docs_fts MATCH ? AND d.published_at >= datetime('now', ?)
              ORDER BY bm25(docs_fts), d.published_at DESC LIMIT ?`,
        args: [match, `-${opts.days} days`, opts.limit],
      })
      return res.rows as DocumentSearchRow[]
    } catch {
      // 索引损坏或方言不支持：静默回退，检索能力不能因此不可用
    }
  }
  const like = `%${query}%`
  const res = await db.execute({
    sql: `SELECT id, title, source_id, published_at FROM source_documents
          WHERE published_at >= datetime('now', ?)
            AND (title LIKE ? OR full_text LIKE ? OR metadata_json LIKE ?)
          ORDER BY published_at DESC LIMIT ?`,
    args: [`-${opts.days} days`, like, like, like, opts.limit],
  })
  return res.rows as DocumentSearchRow[]
}
