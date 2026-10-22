import crypto from 'crypto'
import { getDb } from '../../db'
import { todayShanghai } from '../format'
import {
  assertNoDemoData,
  ensureCockpitSources,
  markSourceFailure,
  markSourceSuccess,
} from './registry'

/**
 * T0 官方披露适配器：
 * - 上交所公告（sh）
 * - 巨潮资讯公告（sz；北交所暂不猜测接口）
 * - 证监会政策解读（列表页）
 * 只保存标题、发布日期与官方原文链接，不抓取或改写正文。
 */

const SOURCE = {
  sse: { id: 'sse', name: '上海证券交易所', base: 'https://www.sse.com.cn' },
  cninfo: { id: 'cninfo', name: '巨潮资讯', base: 'https://www.cninfo.com.cn' },
  csrc: { id: 'csrc', name: '中国证监会', base: 'https://www.csrc.gov.cn' },
} as const
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'
const LOOKBACK_DAYS = 30
const MAX_CODES = 30

type FetchLike = typeof fetch

export interface OfficialIngestResult {
  tradeDate: string
  documents: number
  bySource: Record<string, number>
  warnings: string[]
}

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 上海日期的零点存成 UTC（前一日 16:00Z），与简报的收盘截止口径一致。 */
function shanghaiMidnight(date: string): string {
  const d = new Date(`${date}T00:00:00+08:00`)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function stripTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim()
}

function docId(sourceId: string, externalId: string): string {
  return `${sourceId}:${crypto.createHash('sha1').update(externalId).digest('hex').slice(0, 24)}`
}

interface DocInput {
  sourceId: string
  externalId: string
  docType: string
  title: string
  issuer?: string
  publishedAt: string
  url: string
  code?: string
}

async function saveDocuments(docs: DocInput[], fetchedAt: string): Promise<number> {
  if (docs.length === 0) return 0
  const db = await getDb()
  const tx = await db.transaction('write')
  let inserted = 0
  try {
    for (const doc of docs) {
      const res = await tx.execute({
        sql: `INSERT OR IGNORE INTO source_documents
              (id, source_id, doc_type, external_id, title, issuer, document_no, published_at,
               effective_at, status, url, content_path, full_text, raw_hash, fetched_at,
               supersedes_id, metadata_json, is_demo)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?, 0)`,
        args: [
          docId(doc.sourceId, doc.externalId),
          doc.sourceId,
          doc.docType,
          doc.externalId,
          doc.title.slice(0, 300),
          doc.issuer || null,
          doc.publishedAt,
          doc.url,
          crypto.createHash('sha256').update(`${doc.sourceId}|${doc.externalId}|${doc.title}`).digest('hex'),
          fetchedAt,
          JSON.stringify(doc.code ? { code: doc.code } : {}),
        ],
      })
      inserted += Number(res.rowsAffected || 0)
    }
    await tx.commit()
    return inserted
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function relevantCodes(): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT code FROM (
            SELECT code FROM watchlist_items
            UNION
            SELECT code FROM positions WHERE account_id <> 'demo-account' AND shares > 0
          ) ORDER BY code`,
    args: [],
  })
  return res.rows.map((row) => str(row.code)).filter(Boolean).slice(0, MAX_CODES)
}

async function fetchSseAnnouncements(
  code: string,
  startDate: string,
  endDate: string,
  fetchImpl: FetchLike,
): Promise<DocInput[]> {
  const digits = code.slice(0, 6)
  const params = new URLSearchParams({
    isPagination: 'true',
    productId: digits,
    securityType: '0101,120100,020100,020200,120200',
    reportType2: 'DQBG',
    reportType: 'ALL',
    beginDate: '',
    endDate: '',
    'pageHelp.pageSize': '30',
    'pageHelp.pageCount': '50',
    'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1',
    'pageHelp.cacheSize': '1',
    'pageHelp.endPage': '5',
  })
  const res = await fetchImpl(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.sse.com.cn/' },
  })
  if (!res.ok) throw new Error(`上交所公告 HTTP ${res.status}`)
  const json = await res.json() as { pageHelp?: { data?: Array<Record<string, unknown>> } }
  const rows = json.pageHelp?.data || []
  return rows.flatMap((row) => {
    const date = str(row.SSEDATE).slice(0, 10)
    const title = stripTags(str(row.TITLE))
    const path = str(row.URL).replace(/\\\//g, '/')
    if (!date || !title || !path || date < startDate || date > endDate) return []
    return [{
      sourceId: SOURCE.sse.id,
      externalId: path,
      docType: 'announcement',
      title,
      issuer: str(row.SECURITY_NAME) || undefined,
      publishedAt: shanghaiMidnight(date),
      url: path.startsWith('http') ? path : `${SOURCE.sse.base}${path}`,
      code,
    }]
  })
}

interface CninfoMatch {
  code: string
  orgId: string
  name: string
}

async function lookupCninfo(code: string, fetchImpl: FetchLike): Promise<CninfoMatch | null> {
  const res = await fetchImpl(`${SOURCE.cninfo.base}/new/information/topSearch/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': UA,
      Referer: `${SOURCE.cninfo.base}/new/index`,
    },
    body: new URLSearchParams({ keyWord: code.slice(0, 6), maxNum: '10' }).toString(),
  })
  if (!res.ok) throw new Error(`巨潮代码查询 HTTP ${res.status}`)
  const json = await res.json() as Array<Record<string, unknown>>
  const match = Array.isArray(json)
    ? json.find((item) => str(item.code) === code.slice(0, 6) && str(item.orgId))
    : undefined
  return match ? { code: str(match.code), orgId: str(match.orgId), name: str(match.zwjc) } : null
}

async function fetchCninfoAnnouncements(
  code: string,
  startDate: string,
  endDate: string,
  fetchImpl: FetchLike,
): Promise<DocInput[]> {
  const match = await lookupCninfo(code, fetchImpl)
  if (!match) return []
  const res = await fetchImpl(`${SOURCE.cninfo.base}/new/hisAnnouncement/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': UA,
      Referer: `${SOURCE.cninfo.base}/new/disclosure/stock?stockCode=${match.code}&orgId=${match.orgId}`,
    },
    body: new URLSearchParams({
      pageNum: '1',
      pageSize: '30',
      column: 'szse',
      tabName: 'fulltext',
      plate: 'sz',
      stock: `${match.code},${match.orgId}`,
      searchkey: '',
      seDate: `${startDate}~${endDate}`,
      category: '',
      trade: '',
      sortName: 'time',
      sortType: 'desc',
      isHLtitle: 'true',
    }).toString(),
  })
  if (!res.ok) throw new Error(`巨潮公告 HTTP ${res.status}`)
  const json = await res.json() as { announcements?: Array<Record<string, unknown>> }
  const rows = json.announcements || []
  return rows.flatMap((row) => {
    const id = str(row.announcementId)
    const title = stripTags(str(row.announcementTitle))
    const url = str(row.adjunctUrl)
    const time = Number(row.announcementTime)
    if (!id || !title || !url || !Number.isFinite(time)) return []
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(time))
    if (date < startDate || date > endDate) return []
    return [{
      sourceId: SOURCE.cninfo.id,
      externalId: id,
      docType: 'announcement',
      title,
      issuer: str(row.secName) || match.name || undefined,
      publishedAt: new Date(time).toISOString(),
      url: url.startsWith('http') ? url : `https://static.cninfo.com.cn/${url}`,
      code,
    }]
  })
}

async function fetchCsrcPolicy(
  startDate: string,
  endDate: string,
  fetchImpl: FetchLike,
): Promise<DocInput[]> {
  const res = await fetchImpl(`${SOURCE.csrc.base}/csrc/c100039/common_list.shtml`, {
    headers: { 'User-Agent': UA, Referer: `${SOURCE.csrc.base}/` },
  })
  if (!res.ok) throw new Error(`证监会政策解读 HTTP ${res.status}`)
  const html = await res.text()
  const pattern = /<li>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<span class="date">([0-9-]{10})<\/span>/g
  const docs: DocInput[] = []
  for (const match of html.matchAll(pattern)) {
    const path = match[1]
    const title = stripTags(match[2])
    const date = match[3]
    if (!path || !title || date < startDate || date > endDate) continue
    docs.push({
      sourceId: SOURCE.csrc.id,
      externalId: path,
      docType: 'policy',
      title,
      issuer: '中国证监会',
      publishedAt: shanghaiMidnight(date),
      url: path.startsWith('http') ? path : `${SOURCE.csrc.base}${path}`,
    })
  }
  return docs
}

export async function ingestOfficialDocuments(options: {
  tradeDate?: string
  fetchImpl?: FetchLike
  maxCodes?: number
} = {}): Promise<OfficialIngestResult> {
  const fetchImpl = options.fetchImpl || fetch
  await ensureCockpitSources()
  await assertNoDemoData()

  const tradeDate = options.tradeDate || todayShanghai()
  const startDate = addDays(tradeDate, -LOOKBACK_DAYS)
  const fetchedAt = new Date().toISOString()
  const warnings: string[] = []
  const bySource: Record<string, number> = { sse: 0, cninfo: 0, csrc: 0 }
  const attempts: Record<string, number> = { sse: 0, cninfo: 0, csrc: 0 }
  const successes: Record<string, number> = { sse: 0, cninfo: 0, csrc: 0 }
  const docs: DocInput[] = []

  const codes = (await relevantCodes()).slice(0, options.maxCodes ?? MAX_CODES)
  for (const code of codes) {
    if (code.endsWith('.SH')) {
      attempts.sse += 1
      try {
        docs.push(...await fetchSseAnnouncements(code, startDate, tradeDate, fetchImpl))
        successes.sse += 1
      } catch (err) {
        warnings.push(`${code} 上交所公告：${err instanceof Error ? err.message : String(err)}`)
      }
    } else if (code.endsWith('.SZ')) {
      attempts.cninfo += 1
      try {
        docs.push(...await fetchCninfoAnnouncements(code, startDate, tradeDate, fetchImpl))
        successes.cninfo += 1
      } catch (err) {
        warnings.push(`${code} 巨潮公告：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      warnings.push(`${code} 的交易所不在已接入的公告源内`)
    }
  }

  attempts.csrc += 1
  try {
    docs.push(...await fetchCsrcPolicy(startDate, tradeDate, fetchImpl))
    successes.csrc += 1
  } catch (err) {
    warnings.push(`证监会政策：${err instanceof Error ? err.message : String(err)}`)
  }

  const inserted = await saveDocuments(docs, fetchedAt)
  for (const doc of docs) bySource[doc.sourceId] = (bySource[doc.sourceId] || 0) + 1

  for (const sourceId of Object.keys(attempts)) {
    if (attempts[sourceId] === 0) continue
    if (successes[sourceId] > 0) await markSourceSuccess(sourceId, fetchedAt)
    else await markSourceFailure(sourceId, warnings.slice(-3).join('；') || '全部请求失败')
  }

  return { tradeDate, documents: inserted, bySource, warnings }
}
