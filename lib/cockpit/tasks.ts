import crypto from 'crypto'
import { getDb } from '../db'
import { buildAndStoreDailyReport, PROMPT_VERSION } from './brief'
import { todayShanghai } from './format'
import { getJournal, getPortfolio, getStockDetail, getTheses, getTodayPayload } from './repo'
import type { TaskEvent, TaskRecord, TaskStatus, TaskType } from './types'

export const TASK_TYPES: TaskType[] = ['daily_brief', 'thesis_review', 'ask', 'weekly_review', 'symbol_deep_dive']
const MAX_ATTEMPTS = 2
const LEASE_MS = 5 * 60 * 1000
const MODEL = 'deterministic'

type Row = Record<string, unknown>

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function defaultIdempotencyKey(type: TaskType, params: Record<string, unknown>, tradeDate: string): string {
  return crypto.createHash('sha256')
    .update(`${type}|${stableStringify(params)}|${tradeDate}|${PROMPT_VERSION}|${MODEL}`)
    .digest('hex')
}

function mapTask(row: Row): TaskRecord {
  return {
    id: str(row.id),
    type: str(row.type),
    status: str(row.status) as TaskStatus,
    progress: num(row.progress),
    step: str(row.step) || undefined,
    params: parseJson<Record<string, unknown>>(row.params_json, {}),
    result: parseJson<Record<string, unknown> | null>(row.result_json, null),
    error: str(row.error_message) || null,
    createdAt: str(row.created_at),
    startedAt: str(row.started_at) || undefined,
    finishedAt: str(row.finished_at) || undefined,
    attempts: num(row.attempts),
    costMicros: num(row.cost_micros),
  }
}

async function appendTaskEvent(
  taskId: string,
  eventType: string,
  payload: Record<string, unknown> | null,
  dbClient?: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const db = dbClient || await getDb()
  await db.execute({
    sql: `INSERT INTO task_events (task_id, seq, event_type, payload_json, created_at)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?
          FROM task_events WHERE task_id = ?`,
    args: [taskId, eventType, payload ? JSON.stringify(payload) : null, new Date().toISOString(), taskId],
  })
}

async function getTaskRow(id: string): Promise<Row | undefined> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] })
  return res.rows[0] as unknown as Row | undefined
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  const row = await getTaskRow(id)
  return row ? mapTask(row) : null
}

export async function listTasks(limit = 50): Promise<TaskRecord[]> {
  const db = await getDb()
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const res = await db.execute({
    sql: 'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?',
    args: [safeLimit],
  })
  return (res.rows as unknown as Row[]).map(mapTask)
}

/** 轮询只取活跃摘要，避免每次 50 条完整结果 + 来源健康度。 */
export async function listActiveTasks(): Promise<TaskRecord[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT * FROM tasks WHERE status IN ('queued', 'running')
          ORDER BY created_at ASC, rowid ASC`,
    args: [],
  })
  return (res.rows as unknown as Row[]).map(mapTask)
}

export async function getTaskEvents(id: string, afterSeq = 0): Promise<TaskEvent[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT seq, event_type, payload_json, created_at FROM task_events
          WHERE task_id = ? AND seq > ? ORDER BY seq ASC`,
    args: [id, Math.max(0, Math.floor(afterSeq))],
  })
  return (res.rows as unknown as Row[]).map((row) => ({
    seq: num(row.seq),
    type: str(row.event_type),
    payload: parseJson<Record<string, unknown> | null>(row.payload_json, null),
    createdAt: str(row.created_at),
  }))
}

/**
 * 同 type + 参数 + 交易日只允许一个任务。显式 key 可用于“今天只生成一次日报”。
 * 排队/运行/成功任务原样返回；失败或取消的任务重置为排队，让同参数可以重试。
 */
export async function enqueueTask(input: {
  type: TaskType
  params?: Record<string, unknown>
  idempotencyKey?: string
}): Promise<TaskRecord> {
  if (!TASK_TYPES.includes(input.type)) throw new Error(`未知任务类型: ${input.type}`)
  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const paramDate = typeof params.tradeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.tradeDate)
    ? params.tradeDate
    : todayShanghai()
  const idempotencyKey = input.idempotencyKey || defaultIdempotencyKey(input.type, params, paramDate)
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    const existingRes = await tx.execute({
      sql: 'SELECT * FROM tasks WHERE idempotency_key = ?',
      args: [idempotencyKey],
    })
    const existing = existingRes.rows[0] as unknown as Row | undefined
    if (existing) {
      const id = str(existing.id)
      if (existing.status === 'failed' || existing.status === 'canceled') {
        const now = new Date().toISOString()
        await tx.execute({
          sql: `UPDATE tasks SET status = 'queued', progress = 0, step = '已重新入队',
                result_json = NULL, error_code = NULL, error_message = NULL,
                attempts = 0, started_at = NULL, finished_at = NULL, heartbeat_at = NULL,
                created_at = ?
                WHERE id = ? AND status IN ('failed', 'canceled')`,
          args: [now, id],
        })
        await appendTaskEvent(id, 'queued', { type: input.type, retry: true }, tx)
        const reset = await tx.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] })
        await tx.commit()
        if (!reset.rows[0]) throw new Error('任务重新入队失败')
        return mapTask(reset.rows[0] as unknown as Row)
      }
      await tx.commit()
      return mapTask(existing)
    }

    const id = crypto.randomUUID()
    await tx.execute({
      sql: `INSERT INTO tasks
        (id, type, params_json, status, progress, step, idempotency_key, attempts, model, cost_micros, created_at)
        VALUES (?, ?, ?, 'queued', 0, '已入队', ?, 0, ?, 0, ?)`,
      args: [id, input.type, JSON.stringify(params), idempotencyKey, MODEL, new Date().toISOString()],
    })
    await appendTaskEvent(id, 'queued', { type: input.type }, tx)
    const inserted = await tx.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] })
    await tx.commit()
    if (!inserted.rows[0]) throw new Error('任务入队失败')
    return mapTask(inserted.rows[0] as unknown as Row)
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function setProgress(id: string, progress: number, step: string): Promise<void> {
  const db = await getDb()
  await db.execute({
    sql: 'UPDATE tasks SET progress = ?, step = ?, heartbeat_at = ? WHERE id = ? AND status = ?',
    args: [Math.max(0, Math.min(100, Math.floor(progress))), step, new Date().toISOString(), id, 'running'],
  })
}

/** 单 worker 认领：写事务内先选再标记，避免两个进程拿到同一行。 */
export async function claimNextTask(): Promise<TaskRecord | null> {
  const db = await getDb()
  const staleBefore = new Date(Date.now() - LEASE_MS).toISOString()
  const tx = await db.transaction('write')
  try {
    await tx.execute({
      sql: `UPDATE tasks SET status = 'queued', step = '租约过期，等待重试', heartbeat_at = NULL
            WHERE status = 'running' AND heartbeat_at IS NOT NULL AND heartbeat_at < ?`,
      args: [staleBefore],
    })
    // 单任务串行：已有 worker 在跑时其它进程/请求只排队，不能再并行认领。
    const running = await tx.execute({
      sql: "SELECT id FROM tasks WHERE status = 'running' LIMIT 1",
      args: [],
    })
    if (running.rows[0]) {
      await tx.rollback()
      return null
    }
    const candidate = await tx.execute({
      sql: "SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
      args: [],
    })
    if (!candidate.rows[0]) {
      await tx.rollback()
      return null
    }
    const id = str(candidate.rows[0].id)
    const now = new Date().toISOString()
    await tx.execute({
      sql: `UPDATE tasks SET status = 'running', progress = 5, step = '开始执行',
            started_at = ?, heartbeat_at = ?, attempts = attempts + 1, error_code = NULL, error_message = NULL
            WHERE id = ? AND status = 'queued'`,
      args: [now, now, id],
    })
    const row = await tx.execute({ sql: 'SELECT * FROM tasks WHERE id = ?', args: [id] })
    await tx.commit()
    if (!row.rows[0]) return null
    const task = mapTask(row.rows[0] as unknown as Row)
    await appendTaskEvent(task.id, 'started', { attempt: task.attempts }, db)
    return task
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function latestTradeDate(): Promise<string | null> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT MAX(trade_date) AS d FROM market_overview', args: [] })
  const value = res.rows[0]?.d
  return value ? String(value) : null
}

async function runTask(task: TaskRecord): Promise<Record<string, unknown>> {
  const params = task.params || {}
  switch (task.type) {
    case 'daily_brief': {
      const tradeDate = typeof params.tradeDate === 'string' ? params.tradeDate : await latestTradeDate()
      if (!tradeDate) throw new Error('没有可用的交易日，先完成行情入库')
      await setProgress(task.id, 25, '构建事实包')
      const report = await buildAndStoreDailyReport(tradeDate, { force: Boolean(params.force) })
      await setProgress(task.id, 85, '校验并发布')
      return {
        reportId: report.reportId,
        tradeDate,
        version: report.version,
        claim: report.payload.hero.claim,
        confidence: report.payload.hero.confidence.label,
      }
    }
    case 'thesis_review': {
      await setProgress(task.id, 30, '读取论点与证据')
      const theses = await getTheses()
      const code = typeof params.code === 'string' ? params.code : null
      const target = code ? theses.filter((thesis) => thesis.code === code) : theses
      if (target.length === 0) throw new Error('没有可复核的论点')
      const db = await getDb()
      const now = new Date().toISOString()
      for (const thesis of target) {
        await db.execute({
          sql: 'UPDATE theses SET last_reviewed_at = ?, updated_at = ? WHERE id = ?',
          args: [now, now, thesis.id],
        })
      }
      await setProgress(task.id, 85, '写入复核时间')
      return {
        reviewed: target.length,
        weakened: target.filter((thesis) => thesis.status === 'weakened').length,
        codes: target.map((thesis) => thesis.code),
      }
    }
    case 'ask': {
      const question = typeof params.question === 'string' ? params.question.trim() : ''
      if (!question) throw new Error('问题不能为空')
      await setProgress(task.id, 35, '检索最新简报')
      const payload = await getTodayPayload()
      if (!payload) throw new Error('没有可引用的简报，先生成日报')
      const evidence = payload.hero.evidence
      const citations = evidence
        .filter((item) => item.source)
        .map((item) => ({ id: item.source!.id, name: item.source!.name, tier: item.source!.tier }))
      const answer = [
        payload.hero.claim,
        ...evidence.slice(0, 3).map((item) => `· ${item.label}`),
        `置信度：${payload.hero.confidence.label}（${payload.hero.confidence.score}）`,
      ].join('\n')
      return { question, answer, citations, tradeDate: payload.tradeDate }
    }
    case 'weekly_review': {
      await setProgress(task.id, 30, '汇总持仓与论点')
      const [portfolio, theses, journal] = await Promise.all([getPortfolio(), getTheses(), getJournal(20)])
      return {
        totalValue: portfolio.totalValue,
        totalPnl: portfolio.totalPnl,
        positions: portfolio.positions.length,
        theses: theses.length,
        weakened: theses.filter((thesis) => thesis.status === 'weakened').length,
        journalEntries: journal.length,
        note: '周报为结构汇总；结论需逐条核对证据后再写入研究页。',
      }
    }
    case 'symbol_deep_dive': {
      const code = typeof params.code === 'string' ? params.code : ''
      if (!code) throw new Error('缺少股票代码')
      await setProgress(task.id, 35, '读取个股事实')
      const detail = await getStockDetail(code)
      if (!detail) throw new Error(`未找到标的 ${code}`)
      return {
        code: detail.code,
        name: detail.name,
        price: detail.price,
        thesisStatus: detail.thesis?.status || null,
        evidence: detail.evidence.slice(0, 5),
        documents: detail.documents.slice(0, 3).map((doc) => ({ id: doc.id, title: doc.title, source: doc.source.id })),
      }
    }
    default:
      throw new Error(`未知任务类型: ${task.type}`)
  }
}

async function finishTask(
  task: TaskRecord,
  status: TaskStatus,
  patch: { progress?: number; step?: string; result?: unknown; errorCode?: string; errorMessage?: string; requeue?: boolean },
): Promise<TaskRecord> {
  const db = await getDb()
  const now = new Date().toISOString()
  if (patch.requeue) {
    await db.execute({
      sql: `UPDATE tasks SET status = 'queued', progress = 0, step = ?, result_json = NULL,
            error_code = ?, error_message = ?, finished_at = NULL, heartbeat_at = NULL
            WHERE id = ?`,
      args: [patch.step || '等待重试', patch.errorCode || null, patch.errorMessage || null, task.id],
    })
    await appendTaskEvent(task.id, 'retry', {
      error: patch.errorMessage || '未知错误',
      attempt: task.attempts,
    }, db)
  } else {
    await db.execute({
      sql: `UPDATE tasks SET status = ?, progress = ?, step = ?, result_json = ?,
            error_code = ?, error_message = ?, finished_at = ?, heartbeat_at = ?
            WHERE id = ?`,
      args: [
        status,
        patch.progress ?? (status === 'succeeded' ? 100 : task.progress),
        patch.step || (status === 'succeeded' ? '完成' : '失败'),
        patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.errorCode || null,
        patch.errorMessage || null,
        now,
        now,
        task.id,
      ],
    })
    await appendTaskEvent(task.id, status, {
      error: patch.errorMessage || null,
      result: patch.result || null,
    }, db)
  }
  const row = await getTaskRow(task.id)
  return row ? mapTask(row) : task
}

export async function processNextTask(): Promise<TaskRecord | null> {
  const task = await claimNextTask()
  if (!task) return null
  try {
    const result = await runTask(task)
    return await finishTask(task, 'succeeded', { progress: 100, step: '完成', result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const safeMessage = message.slice(0, 500)
    if (task.attempts < MAX_ATTEMPTS) {
      return await finishTask(task, 'queued', {
        step: '等待重试',
        errorCode: 'RETRYABLE',
        errorMessage: safeMessage,
        requeue: true,
      })
    }
    return await finishTask(task, 'failed', {
      progress: task.progress,
      step: '失败',
      errorCode: 'TASK_FAILED',
      errorMessage: safeMessage,
    })
  }
}

let drainPromise: Promise<void> | null = null

/**
 * 持续消化队列直到为空：失败任务 requeue 后立刻再认领一次，重试才真正发生。
 * 同进程只跑一个 drain；跨进程由 claimNextTask 的 running 行互斥。
 */
export async function drainTasks(): Promise<void> {
  if (drainPromise) return drainPromise
  drainPromise = (async () => {
    while (await processNextTask()) { /* 继续下一条 */ }
  })().finally(() => {
    drainPromise = null
  })
  return drainPromise
}

/** 响应发出后再执行，避免把 worker 时长算进派发请求。 */
export function scheduleTaskDrain(delay = 10): void {
  setTimeout(() => {
    void drainTasks().catch((err) => {
      console.error('[cockpit/tasks] worker', err instanceof Error ? err.message : err)
    })
  }, delay)
}

/** 只取消尚未开始的队列任务；运行中的任务交给租约与超时机制。 */
export async function cancelTask(id: string): Promise<TaskRecord | null> {
  const db = await getDb()
  const now = new Date().toISOString()
  const result = await db.execute({
    sql: `UPDATE tasks SET status = 'canceled', progress = 0, step = '已取消',
          error_code = 'CANCELED', error_message = '用户取消', finished_at = ?, heartbeat_at = ?
          WHERE id = ? AND status = 'queued'`,
    args: [now, now, id],
  })
  if (Number(result.rowsAffected) > 0) {
    await appendTaskEvent(id, 'canceled', { by: 'user' }, db)
  }
  return getTask(id)
}
