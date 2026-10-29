import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 官方披露适配器：只保存可回溯的标题/日期/原文链接。
 * 用固定响应覆盖三件事：日期窗口过滤、URL 绝对化、单一来源失败不拖垮其它来源。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-official-test-'))
let official: typeof import('../lib/cockpit/sources/official')
let dbModule: typeof import('../lib/db')

type FetchLike = typeof fetch

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response
}

function htmlResponse(html: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => html,
    json: async () => ({}),
  } as Response
}

const CSRC_HTML = `
<ul>
  <li><a href="/csrc/c100039/c1.shtml" target="_blank">关于资本市场长期资金入市的政策解读</a><span class="date">2026-10-21</span></li>
  <li><a href="/csrc/c100039/old.shtml" target="_blank">过期解读</a><span class="date">2025-01-01</span></li>
</ul>
`

function makeFetch({ sseFails = false } = {}): FetchLike {
  return vi.fn(async (input: string) => {
    if (input.includes('query.sse.com.cn')) {
      if (sseFails) return jsonResponse({ error: 'boom' }, false, 500)
      return jsonResponse({
        pageHelp: {
          data: [
            {
              SSEDATE: '2026-10-20',
              TITLE: '关于<em>回购</em>股份的公告',
              SECURITY_NAME: '贵州茅台',
              URL: '/disclosure/listedinfo/announcement/c/new/2026-10-20/600519_1.pdf',
            },
            {
              SSEDATE: '2025-01-01',
              TITLE: '过期公告',
              SECURITY_NAME: '贵州茅台',
              URL: '/old.pdf',
            },
            { SSEDATE: '2026-10-20', TITLE: '', SECURITY_NAME: '贵州茅台', URL: '/empty.pdf' },
          ],
        },
      })
    }
    if (input.endsWith('/topSearch/query')) {
      return jsonResponse([{ code: '300750', orgId: '9900000001', zwjc: '宁德时代' }])
    }
    if (input.endsWith('/hisAnnouncement/query')) {
      return jsonResponse({
        announcements: [
          {
            announcementId: 'ann-1',
            announcementTitle: '<em>关于</em>签订储能框架协议的公告',
            adjunctUrl: 'finalpage/2026-10-21/ann-1.PDF',
            announcementTime: Date.parse('2026-10-21T10:00:00+08:00'),
            secName: '宁德时代',
          },
          {
            announcementId: 'ann-old',
            announcementTitle: '过期公告',
            adjunctUrl: 'finalpage/2025-01-01/old.PDF',
            announcementTime: Date.parse('2025-01-01T10:00:00+08:00'),
            secName: '宁德时代',
          },
        ],
      })
    }
    if (input.includes('csrc.gov.cn')) return htmlResponse(CSRC_HTML)
    return jsonResponse({ error: 'unexpected url' }, false, 404)
  }) as unknown as FetchLike
}

describe('官方公告与政策入库', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'official.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    official = await import('../lib/cockpit/sources/official')
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    await db.execute({
      sql: "INSERT INTO watchlist_items (code, note, created_at) VALUES ('600519.SH', NULL, ?)",
      args: [now],
    })
    await db.execute({
      sql: "INSERT INTO watchlist_items (code, note, created_at) VALUES ('300750.SZ', NULL, ?)",
      args: [now],
    })
  })

  it('三家官方来源各入库一条，URL、日期与 HTML 标题正确清洗', async () => {
    const result = await official.ingestOfficialDocuments({
      tradeDate: '2026-10-22',
      fetchImpl: makeFetch(),
    })
    expect(result.documents).toBe(3)
    expect(result.bySource).toEqual({ sse: 1, cninfo: 1, csrc: 1 })
    expect(result.warnings).toEqual([])

    const db = await dbModule.getDb()
    const docs = await db.execute({
      sql: 'SELECT source_id, title, published_at, url, metadata_json FROM source_documents ORDER BY source_id',
      args: [],
    })
    expect(docs.rows).toHaveLength(3)

    const sse = docs.rows.find((row) => row.source_id === 'sse')
    expect(sse?.title).toBe('关于回购股份的公告')
    expect(sse?.url).toBe('https://www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-10-20/600519_1.pdf')
    expect(sse?.published_at).toBe('2026-10-19T16:00:00.000Z')
    expect(JSON.parse(String(sse?.metadata_json))).toEqual({ code: '600519.SH' })

    const cninfo = docs.rows.find((row) => row.source_id === 'cninfo')
    expect(cninfo?.title).toBe('关于签订储能框架协议的公告')
    expect(cninfo?.url).toBe('https://static.cninfo.com.cn/finalpage/2026-10-21/ann-1.PDF')
    expect(cninfo?.published_at).toBe(new Date(Date.parse('2026-10-21T10:00:00+08:00')).toISOString())

    const csrc = docs.rows.find((row) => row.source_id === 'csrc')
    expect(csrc?.title).toBe('关于资本市场长期资金入市的政策解读')
    expect(csrc?.url).toBe('https://www.csrc.gov.cn/csrc/c100039/c1.shtml')

    const health = await db.execute({
      sql: "SELECT id, enabled, last_error FROM source_registry WHERE id IN ('sse','cninfo','csrc') ORDER BY id",
      args: [],
    })
    expect(health.rows.map((row) => Number(row.enabled))).toEqual([1, 1, 1])
    expect(health.rows.every((row) => row.last_error === null)).toBe(true)
  })

  it('单一来源失败只记警告并标红，其它来源照常写入', async () => {
    const result = await official.ingestOfficialDocuments({
      tradeDate: '2026-10-22',
      fetchImpl: makeFetch({ sseFails: true }),
    })
    // 重复文档被唯一索引忽略，但来源侧仍统计到 2 条
    expect(result.documents).toBe(0)
    expect(result.bySource.cninfo).toBe(1)
    expect(result.bySource.csrc).toBe(1)
    expect(result.bySource.sse).toBe(0)
    expect(result.warnings.join(' ')).toContain('上交所公告')

    const db = await dbModule.getDb()
    const sse = await db.execute({
      sql: "SELECT enabled, last_error, consecutive_failures FROM source_registry WHERE id = 'sse'",
      args: [],
    })
    expect(Number(sse.rows[0]?.enabled)).toBe(1)
    expect(String(sse.rows[0]?.last_error)).toContain('HTTP 500')
    expect(Number(sse.rows[0]?.consecutive_failures)).toBe(1)
  })

  it('库里出现示例公告后拒绝接入并停止请求', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO source_documents
            (id, source_id, doc_type, external_id, title, published_at, fetched_at, is_demo)
            VALUES ('demo-doc', 'demo-sse', 'announcement', 'demo-ext', '示例公告', ?, ?, 1)`,
      args: [new Date().toISOString(), new Date().toISOString()],
    })
    const fetchImpl = vi.fn() as unknown as FetchLike
    await expect(official.ingestOfficialDocuments({ tradeDate: '2026-10-22', fetchImpl }))
      .rejects.toThrow('示例行情')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
