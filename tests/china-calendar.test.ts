import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 节假日日历：ICS 解析、调休补班休市、Tushare 行不被覆盖，
 * 以及 2028 这类未内嵌年份按年订阅的路径。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'china-calendar-test-'))
let db: any
let calendar: typeof import('../lib/china-calendar')

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'calendar.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  calendar = await import('../lib/china-calendar')
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ICS 解析', () => {
  it('展开休假日与调休补班日，忽略无关事件', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260101',
      'DTEND;VALUE=DATE:20260104',
      'SUMMARY:休｜元旦',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260104',
      'DTEND;VALUE=DATE:20260105',
      'SUMMARY:班｜调休补班',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260110',
      'DTEND;VALUE=DATE:20260111',
      'SUMMARY:会议',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(calendar.parseChinaCalendarIcs(ics)).toEqual([
      { date: '2026-01-01', kind: 'holiday', name: '元旦' },
      { date: '2026-01-02', kind: 'holiday', name: '元旦' },
      { date: '2026-01-03', kind: 'holiday', name: '元旦' },
      { date: '2026-01-04', kind: 'workday', name: '调休补班' },
    ])
  })
})

describe('交易日判定', () => {
  it('库内缺记录时先落内置日历，调休补班日仍休市', async () => {
    await expect(calendar.isChinaMarketOpen('2027-02-14', { allowNetwork: false })).resolves.toBe(false)
    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE trade_date LIKE '2027-%'",
      args: [],
    })
    expect(Number(rows.rows[0]?.n)).toBe(365)
  })

  it('2026/2027 覆盖后直接读库，节假日与补班日都休市', async () => {
    const ensured = await calendar.ensureChinaCalendar({
      years: [2026, 2027],
      allowNetwork: false,
      now: '2026-11-23T00:00:00.000Z',
    })
    expect(ensured.bundled).toContain(2026)
    expect(ensured.cached).toContain(2027)

    await expect(calendar.isChinaMarketOpen('2026-10-01')).resolves.toBe(false)
    await expect(calendar.isChinaMarketOpen('2026-10-10')).resolves.toBe(false)
    await expect(calendar.isChinaMarketOpen('2026-11-23')).resolves.toBe(true)
    await expect(calendar.isChinaMarketOpen('2027-02-14')).resolves.toBe(false)
    await expect(calendar.isChinaMarketOpen('2027-02-15')).resolves.toBe(true)
  })

  it('重建日历不会覆盖 Tushare 的权威记录', async () => {
    await db.execute({ sql: "DELETE FROM trading_calendar WHERE trade_date LIKE '2026-%'", args: [] })
    await db.execute({
      sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES ('2026-10-01', 1, 'tushare', ?)`,
      args: ['2026-01-01T00:00:00.000Z'],
    })
    await calendar.ensureChinaCalendar({ years: [2026], allowNetwork: false })

    const kept = await db.execute({
      sql: "SELECT is_open, source_id FROM trading_calendar WHERE trade_date = '2026-10-01'",
      args: [],
    })
    expect(kept.rows[0]).toMatchObject({ is_open: 1, source_id: 'tushare' })

    const seeded = await db.execute({
      sql: "SELECT is_open, source_id FROM trading_calendar WHERE trade_date = '2026-10-02'",
      args: [],
    })
    expect(seeded.rows[0]).toMatchObject({ is_open: 0, source_id: 'china-calendar-ics' })
  })

  it('未内嵌的年份按年订阅，2028 发布后即可生效', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20280103',
      'DTEND;VALUE=DATE:20280104',
      'SUMMARY:休｜测试假日',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n')
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(String(url))
      return { ok: true, status: 200, text: async () => ics }
    }) as any

    const ensured = await calendar.ensureChinaCalendar({ years: [2028], allowNetwork: true, fetchImpl })
    expect(ensured.fetched).toEqual([2028])
    expect(urls).toEqual(['https://chinacalendar.app/ics/china-calendar-2028.ics'])
    await expect(calendar.isChinaMarketOpen('2028-01-03')).resolves.toBe(false)
    await expect(calendar.isChinaMarketOpen('2028-01-04')).resolves.toBe(true)
  })

  it('新年份未发布时保留工作日降级，不抛错', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, text: async () => '' })) as any
    await expect(calendar.ensureChinaCalendar({ years: [2029], allowNetwork: true, fetchImpl }))
      .resolves.toMatchObject({ years: [2029] })
    await expect(calendar.isChinaMarketOpen('2029-01-03')).resolves.toBe(true)
    await expect(calendar.isChinaMarketOpen('2029-01-06')).resolves.toBe(false)
  })
})
