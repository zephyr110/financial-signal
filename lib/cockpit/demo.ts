import { getDb } from '../db'
import { buildAndStoreDailyReport } from './brief'

export const DEMO_TRADE_DATE = '2026-10-22'
const SEED_KEY = 'cockpit_demo_seed_v1'

const DEMO_HOLIDAYS = new Set([
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06',
  '2026-10-07', '2026-10-08',
])

const SOURCES = [
  {
    id: 'demo-market', name: '示例行情（非真实）', tier: 2, kind: 'market',
    base_url: 'https://example.com/demo-market', enabled: 1, is_demo: 1,
    last_success_at: '2026-10-22T07:35:00.000Z', last_error: null,
  },
  {
    id: 'demo-policy', name: '示例政策（非真实）', tier: 2, kind: 'policy',
    base_url: 'https://example.com/demo-policy', enabled: 1, is_demo: 1,
    last_success_at: '2026-10-22T07:30:00.000Z', last_error: null,
  },
  {
    id: 'demo-announcement', name: '示例公告（非真实）', tier: 2, kind: 'announcement',
    base_url: 'https://example.com/demo-announcement', enabled: 1, is_demo: 1,
    last_success_at: '2026-10-22T07:30:00.000Z', last_error: null,
  },
  {
    id: 'sse', name: '上海证券交易所', tier: 0, kind: 'exchange',
    base_url: 'https://www.sse.com.cn', enabled: 0, is_demo: 0,
    last_success_at: null, last_error: '适配器尚未接入，等待官方接口验证',
  },
  {
    id: 'cninfo', name: '巨潮资讯', tier: 0, kind: 'disclosure',
    base_url: 'http://www.cninfo.com.cn', enabled: 0, is_demo: 0,
    last_success_at: null, last_error: '适配器尚未接入，等待官方接口验证',
  },
  {
    id: 'csrc', name: '中国证监会', tier: 0, kind: 'regulator',
    base_url: 'https://www.csrc.gov.cn', enabled: 0, is_demo: 0,
    last_success_at: null, last_error: '适配器尚未接入，等待官方接口验证',
  },
  {
    id: 'tushare', name: 'Tushare Pro', tier: 1, kind: 'market',
    base_url: 'https://tushare.pro', enabled: 0, is_demo: 0,
    last_success_at: null, last_error: '未配置 token',
  },
]

const SYMBOLS = [
  ['000001.SH', '上证指数', 'SSE', '指数'],
  ['399001.SZ', '深证成指', 'SZSE', '指数'],
  ['399006.SZ', '创业板指', 'SZSE', '指数'],
  ['600519.SH', '示例白酒', 'SSE', '食品饮料'],
  ['300750.SZ', '示例电池', 'SZSE', '电力设备'],
  ['000858.SZ', '示例酒业', 'SZSE', '食品饮料'],
  ['601318.SH', '示例保险', 'SSE', '非银金融'],
  ['002594.SZ', '示例汽车', 'SZSE', '汽车'],
] as const

const SERIES: Array<{ code: string; base: number; last: number; seed: number; vol: number }> = [
  { code: '000001.SH', base: 3150, last: 0.82, seed: 11, vol: 0.006 },
  { code: '399001.SZ', base: 10180, last: 0.45, seed: 23, vol: 0.007 },
  { code: '399006.SZ', base: 2088, last: -0.35, seed: 37, vol: 0.010 },
  { code: '600519.SH', base: 1500, last: 1.25, seed: 41, vol: 0.012 },
  { code: '300750.SZ', base: 232, last: -0.80, seed: 53, vol: 0.016 },
  { code: '000858.SZ', base: 119, last: 0.35, seed: 67, vol: 0.013 },
  { code: '601318.SH', base: 52, last: 0.15, seed: 79, vol: 0.009 },
  { code: '002594.SZ', base: 105, last: -1.10, seed: 83, vol: 0.015 },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function tradingDaysEnding(end: string, count: number): string[] {
  const [y, m, d] = end.split('-').map(Number)
  const cursor = new Date(Date.UTC(y, m - 1, d))
  const dates: string[] = []
  while (dates.length < count) {
    const iso = cursor.toISOString().slice(0, 10)
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6 && !DEMO_HOLIDAYS.has(iso)) dates.unshift(iso)
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return dates
}

function makeCloses(base: number, lastChangePct: number, seed: number, vol: number, count: number): number[] {
  let state = seed >>> 0
  let value = base
  const closes: number[] = []
  for (let i = 0; i < count - 1; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    const jitter = (state / 2 ** 32) * 2 - 1
    const wave = Math.sin((i + (seed % 7)) / 4.2) * 0.0012
    value *= 1 + 0.0003 + wave + jitter * vol
    closes.push(round2(Math.max(0.01, value)))
  }
  const prev = closes[closes.length - 1] || base
  closes.push(round2(prev * (1 + lastChangePct / 100)))
  return closes
}

function makeDocs() {
  const published = (date: string, hour = 1) => `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`
  return [
    {
      id: 'demo-doc-policy-1',
      source_id: 'demo-policy',
      doc_type: 'policy',
      external_id: 'policy-2026-001',
      title: '【示例】关于推进先进制造业集群数字化转型的若干措施',
      issuer: '示例机关（非真实）',
      document_no: '示例〔2026〕12号',
      published_at: published('2026-10-20', 1),
      effective_at: '2026-10-21',
      status: '现行',
      url: 'https://example.com/demo/policy-1',
      full_text: '示例文本：支持先进制造业集群数字化改造，完善公共服务平台，鼓励金融机构提供中长期资金支持。',
      metadata_json: null,
    },
    {
      id: 'demo-doc-policy-2',
      source_id: 'demo-policy',
      doc_type: 'policy',
      external_id: 'policy-2026-002',
      title: '【示例】关于完善新能源消纳机制的通知',
      issuer: '示例机关（非真实）',
      document_no: '示例〔2026〕15号',
      published_at: published('2026-10-21', 2),
      effective_at: '2026-10-22',
      status: '现行',
      url: 'https://example.com/demo/policy-2',
      full_text: '示例文本：完善新能源消纳责任权重，推动跨省跨区交易，优化储能调用机制。',
      metadata_json: JSON.stringify({ code: '300750.SZ' }),
    },
    {
      id: 'demo-doc-ann-1',
      source_id: 'demo-announcement',
      doc_type: 'announcement',
      external_id: 'ann-2026-001',
      title: '【示例】示例白酒：2026年第三季度报告',
      issuer: '示例白酒',
      document_no: '示例公告 2026-001',
      published_at: published('2026-10-21', 11),
      effective_at: null,
      status: '已披露',
      url: 'https://example.com/demo/announcement-1',
      full_text: '示例文本：公司第三季度营业收入同比增长 4.8%，合同负债环比回升。',
      metadata_json: JSON.stringify({ code: '600519.SH' }),
    },
    {
      id: 'demo-doc-ann-2',
      source_id: 'demo-announcement',
      doc_type: 'announcement',
      external_id: 'ann-2026-002',
      title: '【示例】示例电池：关于签订海外储能框架协议的公告',
      issuer: '示例电池',
      document_no: '示例公告 2026-002',
      published_at: published('2026-10-21', 9),
      effective_at: null,
      status: '已披露',
      url: 'https://example.com/demo/announcement-2',
      full_text: '示例文本：公司签订海外储能框架协议，协议执行期三年，具体金额以订单为准。',
      metadata_json: JSON.stringify({ code: '300750.SZ' }),
    },
    {
      id: 'demo-doc-ann-3',
      source_id: 'demo-announcement',
      doc_type: 'announcement',
      external_id: 'ann-2026-003',
      title: '【示例】示例保险：2026年9月保费收入公告',
      issuer: '示例保险',
      document_no: '示例公告 2026-003',
      published_at: published('2026-10-20', 10),
      effective_at: null,
      status: '已披露',
      url: 'https://example.com/demo/announcement-3',
      full_text: '示例文本：公司 9 月原保险保费收入同比增长 3.1%。',
      metadata_json: JSON.stringify({ code: '601318.SH' }),
    },
  ]
}

/**
 * 只在显式调用（页面/API 在 COCKPIT_DEMO=1 时）或测试里执行。
 * 所有行情、公告、政策均为示例文本，source_registry 与 UI 双重标注。
 */
export async function ensureCockpitDemoSeed(): Promise<{ seeded: boolean; tradeDate: string }> {
  const db = await getDb()
  const marker = await db.execute({ sql: 'SELECT value FROM app_settings WHERE key = ?', args: [SEED_KEY] })
  if (marker.rows[0]) return { seeded: false, tradeDate: DEMO_TRADE_DATE }

  const now = new Date().toISOString()
  // 空库才铺示例；库里已有任何真实记录就整体跳过，避免把示例代码写进真实标的。
  const tx = await db.transaction('write')
  try {
    const claimed = await tx.execute({
      sql: 'SELECT value FROM app_settings WHERE key = ?',
      args: [SEED_KEY],
    })
    if (claimed.rows[0]) {
      await tx.commit()
      return { seeded: false, tradeDate: DEMO_TRADE_DATE }
    }
    const real = await tx.execute({ sql: REAL_DATA_SQL, args: [] })
    if (real.rows[0]) {
      await tx.commit()
      return { seeded: false, tradeDate: DEMO_TRADE_DATE }
    }
    await seedDemoBase(tx, now)
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* 事务已关闭 */ }
    throw err
  }

  const report = await buildAndStoreDailyReport(DEMO_TRADE_DATE)
  const taskRows = [
    {
      id: 'demo-task-brief',
      type: 'daily_brief',
      params: JSON.stringify({ tradeDate: DEMO_TRADE_DATE, demo: true }),
      result: JSON.stringify({ reportId: report.reportId, tradeDate: DEMO_TRADE_DATE, version: report.version }),
      key: 'demo|daily_brief|2026-10-22',
      created: '2026-10-22T07:36:00.000Z',
      started: '2026-10-22T07:36:01.000Z',
      finished: '2026-10-22T07:36:04.000Z',
    },
    {
      id: 'demo-task-thesis',
      type: 'thesis_review',
      params: JSON.stringify({ scope: 'all', demo: true }),
      result: JSON.stringify({ reviewed: 3, changed: 1 }),
      key: 'demo|thesis_review|2026-10-22',
      created: '2026-10-21T12:10:00.000Z',
      started: '2026-10-21T12:10:01.000Z',
      finished: '2026-10-21T12:10:03.000Z',
    },
  ]
  const tx2 = await db.transaction('write')
  try {
    for (const task of taskRows) {
      await tx2.execute({
        sql: `INSERT OR IGNORE INTO tasks
          (id, type, params_json, status, progress, step, result_json, error_code, error_message,
           idempotency_key, attempts, model, cost_micros, created_at, started_at, finished_at, heartbeat_at)
          VALUES (?, ?, ?, 'succeeded', 100, '完成', ?, NULL, NULL, ?, 1, 'deterministic', 0, ?, ?, ?, ?)`,
        args: [task.id, task.type, task.params, task.result, task.key, task.created, task.started, task.finished, task.finished],
      })
      await tx2.execute({
        sql: `INSERT OR IGNORE INTO task_events (task_id, seq, event_type, payload_json, created_at)
              VALUES (?, 1, 'succeeded', ?, ?)`,
        args: [task.id, task.result, task.finished],
      })
    }

    await tx2.execute({
      sql: 'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
      args: [SEED_KEY, JSON.stringify({ tradeDate: DEMO_TRADE_DATE, seededAt: now }), now],
    })
    await tx2.commit()
  } catch (err) {
    try { await tx2.rollback() } catch { /* 事务已关闭 */ }
    throw err
  }

  return { seeded: true, tradeDate: DEMO_TRADE_DATE }
}

/** 空库判定：任一真实（非示例）记录存在，就不铺演示数据。 */
const REAL_DATA_SQL = `SELECT 1 FROM symbols WHERE source_id IS NOT NULL AND source_id <> 'demo-market'
  UNION ALL SELECT 1 FROM trading_calendar WHERE source_id <> 'demo-market'
  UNION ALL SELECT 1 FROM source_documents WHERE is_demo = 0
  UNION ALL SELECT 1 FROM market_bars WHERE is_demo = 0
  UNION ALL SELECT 1 FROM market_overview WHERE is_demo = 0
  UNION ALL SELECT 1 FROM limit_pool WHERE is_demo = 0
  UNION ALL SELECT 1 FROM positions WHERE account_id <> 'demo-account'
  UNION ALL SELECT 1 FROM portfolio_accounts WHERE id <> 'demo-account'
  UNION ALL SELECT 1 FROM theses WHERE id NOT LIKE 'thesis-demo-%'
  UNION ALL SELECT 1 FROM journal_entries WHERE reason NOT LIKE '【示例】%'
  UNION ALL SELECT 1 FROM tasks WHERE id NOT LIKE 'demo-task-%'
  LIMIT 1`

/** 示例基础数据整体走一个写事务；任一条失败就回滚，不留半个库。 */
async function seedDemoBase(tx: any, now: string): Promise<void> {
  const dates = tradingDaysEnding(DEMO_TRADE_DATE, 30)
  const allCloses = new Map<string, number[]>()

  for (const source of SOURCES) {
    if (source.is_demo) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO source_registry
          (id, name, tier, kind, base_url, terms_url, enabled, last_success_at, last_error,
           consecutive_failures, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 1, ?)`,
        args: [source.id, source.name, source.tier, source.kind, source.base_url, source.enabled, source.last_success_at, source.last_error, now],
      })
    } else {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO source_registry
          (id, name, tier, kind, base_url, terms_url, enabled, last_success_at, last_error,
           consecutive_failures, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, ?)`,
        args: [source.id, source.name, source.tier, source.kind, source.base_url, source.enabled, source.last_success_at, source.last_error, now],
      })
    }
  }

  for (const [code, name, exchange, industry] of SYMBOLS) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES (?, ?, ?, ?, 'demo-market', ?)`,
      args: [code, name, exchange, industry, now],
    })
  }
  for (const date of dates) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'demo-market', ?)`,
      args: [date, now],
    })
  }

  for (const series of SERIES) {
    const closes = makeCloses(series.base, series.last, series.seed, series.vol, dates.length)
    allCloses.set(series.code, closes)
    for (let i = 0; i < dates.length; i++) {
      const close = closes[i]
      const prev = i > 0 ? closes[i - 1] : close
      const open = round2(prev * (1 + (i % 3 === 0 ? 0.0015 : -0.0008)))
      const high = round2(Math.max(open, close) * 1.004)
      const low = round2(Math.min(open, close) * 0.996)
      const seed = series.seed + i * 17
      const volume = Math.round((800_000 + (seed % 13) * 120_000) * (series.code.startsWith('000001') ? 900 : 1))
      const amount = close * volume
      await tx.execute({
        sql: `INSERT OR IGNORE INTO market_bars
          (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
           source_id, fetched_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'raw', 'demo-market', ?, 1)`,
        args: [series.code, dates[i], open, high, low, close, volume, amount, '2026-10-22T07:35:00.000Z'],
      })
    }
  }

  await tx.execute({
    sql: `INSERT OR IGNORE INTO market_overview
      (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
      VALUES (?, ?, ?, 'demo-market', 1, ?)`,
    args: [
      DEMO_TRADE_DATE,
      JSON.stringify({ up: 2100, flat: 180, down: 2400, limitUp: 38, limitDown: 9 }),
      JSON.stringify({ value: 8942, changePct: 6.2 }),
      '2026-10-22T07:30:00.000Z',
    ],
  })

  for (const doc of makeDocs()) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO source_documents
        (id, source_id, doc_type, external_id, title, issuer, document_no, published_at,
         effective_at, status, url, content_path, full_text, raw_hash, fetched_at,
         supersedes_id, metadata_json, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, 1)`,
      args: [
        doc.id, doc.source_id, doc.doc_type, doc.external_id, doc.title, doc.issuer,
        doc.document_no, doc.published_at, doc.effective_at, doc.status, doc.url,
        doc.full_text, '2026-10-22T07:30:00.000Z', doc.metadata_json,
      ],
    })
  }

  await tx.execute({
    sql: `INSERT OR IGNORE INTO portfolio_accounts (id, name, currency, created_at)
          VALUES ('demo-account', '示例账户', 'CNY', ?)`,
    args: [now],
  })
  const positionSpecs = [
    { code: '600519.SH', shares: 100, factor: 0.94 },
    { code: '300750.SZ', shares: 500, factor: 1.06 },
    { code: '000858.SZ', shares: 300, factor: 0.97 },
  ]
  for (const spec of positionSpecs) {
    const closes = allCloses.get(spec.code) || []
    const last = closes[closes.length - 1] || 1
    await tx.execute({
      sql: `INSERT OR IGNORE INTO positions
        (account_id, code, shares, avg_cost_cents, opened_at, closed_at, notes, updated_at)
        VALUES ('demo-account', ?, ?, ?, ?, NULL, '示例持仓', ?)`,
      args: [spec.code, spec.shares, Math.round(last * 100 * spec.factor), '2026-09-01', now],
    })
  }

  for (const symbol of SYMBOLS.slice(3)) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO watchlist_items (code, note, created_at)
            VALUES (?, '示例自选', ?)`,
      args: [symbol[0], now],
    })
  }

  const theses = [
    {
      id: 'thesis-demo-moutai',
      code: '600519.SH',
      title: '高端白酒的需求韧性',
      claim: '高端白酒需求仍有韧性，但渠道库存与批价走弱会先于报表反映压力。',
      horizon: '6-12 个月',
      status: 'weakened',
      confidence: '中',
      invalidation: ['单季营收同比连续两个季度低于 5%', '核心产品批价跌破 2400 元并持续 4 周'],
      updated_at: '2026-10-21T12:00:00.000Z',
      last_reviewed_at: '2026-10-21T12:00:00.000Z',
    },
    {
      id: 'thesis-demo-catl',
      code: '300750.SZ',
      title: '储能订单能否对冲电池价格压力',
      claim: '海外储能订单与新产品结构有望对冲动力电池单价下行，但需要同时盯住毛利率与回款。',
      horizon: '6-12 个月',
      status: 'active',
      confidence: '中',
      invalidation: ['储能业务毛利率跌破 15%', '海外订单增速连续两个季度低于 20%'],
      updated_at: '2026-10-21T10:00:00.000Z',
      last_reviewed_at: null,
    },
    {
      id: 'thesis-demo-insurance',
      code: '601318.SH',
      title: '寿险新业务价值修复的持续性',
      claim: '保费收入回升能否传导到新业务价值，仍需观察产品结构与渠道成本。',
      horizon: '3-6 个月',
      status: 'active',
      confidence: '低',
      invalidation: ['新业务价值连续两个季度同比负增长'],
      updated_at: '2026-10-20T11:00:00.000Z',
      last_reviewed_at: null,
    },
  ]
  for (const thesis of theses) {
    await tx.execute({
      sql: `INSERT OR IGNORE INTO theses
        (id, code, title, claim, horizon, status, confidence, invalidation_json,
         created_at, updated_at, last_reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        thesis.id, thesis.code, thesis.title, thesis.claim, thesis.horizon, thesis.status,
        thesis.confidence, JSON.stringify(thesis.invalidation), '2026-09-15T08:00:00.000Z',
        thesis.updated_at, thesis.last_reviewed_at,
      ],
    })
  }

  await tx.execute({
    sql: `DELETE FROM thesis_evidence WHERE thesis_id IN ('thesis-demo-moutai', 'thesis-demo-catl', 'thesis-demo-insurance')`,
    args: [],
  })
  const evidence = [
    ['thesis-demo-moutai', 'oppose', '示例三季报显示营收增速降至 4.8%，低于论点要求', 'demo-doc-ann-1', '2026-10-21T12:00:00.000Z'],
    ['thesis-demo-moutai', 'support', '合同负债环比回升，渠道回款未进一步恶化', 'demo-doc-ann-1', '2026-10-21T12:00:00.000Z'],
    ['thesis-demo-catl', 'support', '海外储能框架协议落地，执行期三年', 'demo-doc-ann-2', '2026-10-21T10:00:00.000Z'],
    ['thesis-demo-catl', 'oppose', '电池单价继续下行，毛利率仍需验证', null, '2026-10-21T10:00:00.000Z'],
    ['thesis-demo-insurance', 'support', '9 月原保险保费收入同比增长 3.1%', 'demo-doc-ann-3', '2026-10-20T11:00:00.000Z'],
  ]
  for (const [thesisId, direction, summary, documentId, observedAt] of evidence) {
    await tx.execute({
      sql: `INSERT INTO thesis_evidence
        (thesis_id, snapshot_id, direction, fact_key, summary, source_document_id, observed_at, created_at)
        VALUES (?, NULL, ?, NULL, ?, ?, ?, ?)`,
      args: [thesisId, direction, summary, documentId, observedAt, now],
    })
  }

  await tx.execute({
    sql: `DELETE FROM journal_entries WHERE reason LIKE '【示例】%'`,
    args: [],
  })
  const journal = [
    ['2026-10-21', '600519.SH', 'hold', '【示例】批价走弱但估值已反映部分压力，等待三季报后再复核。', '未行动'],
    ['2026-10-20', '300750.SZ', 'watch', '【示例】储能订单是主要变量，先记录不追价。', '等待更多公告'],
    ['2026-10-22', null, 'review', '【示例】收盘后检查广度与成交额，确认日报证据链。', null],
  ]
  for (const [entryDate, code, action, reason, outcome] of journal) {
    await tx.execute({
      sql: `INSERT INTO journal_entries
        (entry_date, code, action, thesis_id, reason, outcome_note, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      args: [entryDate, code, action, reason, outcome, now],
    })
  }

}
