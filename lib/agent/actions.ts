/**
 * Agent 安全动作：模型只写“提案”，用户确认后才执行。
 * 执行入口统一走 resolveAgentAction，payload 按类型白名单校验。
 */
import crypto from 'crypto'
import { getDb } from '../db'
import { createNotification } from '../cockpit/notifications'
import { enqueueTask, scheduleTaskDrain } from '../cockpit/tasks'
import type { TaskType } from '../cockpit/types'
import { upsertAgentMemory, type MemoryScope } from './memory'
import { addProjectItem, type ProjectItemKind } from './projects'

export type AgentActionType = 'watch_event' | 'create_task' | 'pin_project' | 'save_memory'
export type AgentActionStatus = 'proposed' | 'confirmed' | 'rejected' | 'expired' | 'failed'

export interface AgentActionView {
  id: string
  sessionId?: string
  turnId?: string
  type: AgentActionType
  payload: Record<string, unknown>
  status: AgentActionStatus
  result?: Record<string, unknown>
  errorMessage?: string
  createdAt: string
  expiresAt?: string
  resolvedAt?: string
}

type Row = Record<string, unknown>

const ACTION_TYPES: AgentActionType[] = ['watch_event', 'create_task', 'pin_project', 'save_memory']
const TASK_TYPES: TaskType[] = [
  'daily_brief',
  'thesis_review',
  'weekly_review',
  'symbol_deep_dive',
  'market_ingest',
  'desk_tick',
  'desk_investigation',
]
const MEMORY_SCOPES: MemoryScope[] = ['user', 'project', 'industry', 'symbol']
const PROJECT_KINDS: ProjectItemKind[] = ['note', 'evidence', 'judgment', 'document', 'symbol']
const ACTION_TTL_HOURS = 24

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function mapAction(row: Row): AgentActionView {
  return {
    id: str(row.id),
    sessionId: str(row.session_id) || undefined,
    turnId: str(row.turn_id) || undefined,
    type: str(row.type) as AgentActionType,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    status: str(row.status) as AgentActionStatus,
    result: parseJson<Record<string, unknown> | undefined>(row.result_json, undefined),
    errorMessage: str(row.error_message) || undefined,
    createdAt: str(row.created_at),
    expiresAt: str(row.expires_at) || undefined,
    resolvedAt: str(row.resolved_at) || undefined,
  }
}

function sanitizeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 12)) {
    if (key === 'lane') continue // lane 由任务类型决定，模型不能把交互任务塞进核心链路
    if (typeof raw === 'string') out[key] = raw.slice(0, 200)
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
    else if (typeof raw === 'boolean') out[key] = raw
  }
  return out
}

/** 只保留白名单字段与长度上限，非法 payload 直接拒绝。 */
export function validateActionPayload(type: AgentActionType, payload: Record<string, unknown>): Record<string, unknown> {
  if (!ACTION_TYPES.includes(type)) throw new Error('动作类型无效')
  switch (type) {
    case 'watch_event': {
      const eventId = payload.eventId == null ? '' : String(payload.eventId).trim().slice(0, 80)
      const code = payload.code == null ? '' : String(payload.code).trim().slice(0, 20)
      const title = payload.title == null ? '' : String(payload.title).trim().slice(0, 200)
      const note = payload.note == null ? '' : String(payload.note).trim().slice(0, 500)
      if (!eventId && !code && !title) throw new Error('关注动作需要 eventId、code 或 title')
      return { ...(eventId ? { eventId } : {}), ...(code ? { code } : {}), ...(title ? { title } : {}), ...(note ? { note } : {}) }
    }
    case 'create_task': {
      const taskType = String(payload.type || '') as TaskType
      if (!TASK_TYPES.includes(taskType)) throw new Error('任务类型不在白名单内')
      const params = sanitizeParams(payload.params)
      // 与 /api/cockpit/tasks 保持同一套必填校验，避免确认一个注定失败的任务。
      if (params.tradeDate !== undefined && (typeof params.tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(params.tradeDate))) {
        throw new Error('tradeDate 格式应为 YYYY-MM-DD')
      }
      if (taskType === 'ask' && (typeof params.question !== 'string' || !params.question.trim())) {
        throw new Error('问答任务需要 question')
      }
      if (taskType === 'symbol_deep_dive' && (typeof params.code !== 'string' || !params.code.trim())) {
        throw new Error('个股深挖需要 code')
      }
      if (taskType === 'desk_investigation' && (typeof params.investigationId !== 'string' || !params.investigationId.trim())) {
        throw new Error('深挖任务需要 investigationId')
      }
      return { type: taskType, params }
    }
    case 'pin_project': {
      const projectId = String(payload.projectId || '').trim()
      const kind = String(payload.kind || '') as ProjectItemKind
      const refId = String(payload.refId || '').trim().slice(0, 200)
      if (!projectId) throw new Error('项目动作需要 projectId')
      if (!PROJECT_KINDS.includes(kind)) throw new Error('项目条目类型无效')
      if (!refId) throw new Error('项目动作需要 refId')
      const title = payload.title == null ? '' : String(payload.title).trim().slice(0, 200)
      const note = payload.note == null ? '' : String(payload.note).trim().slice(0, 1000)
      return { projectId, kind, refId, ...(title ? { title } : {}), ...(note ? { note } : {}) }
    }
    case 'save_memory': {
      const scope = String(payload.scope || 'user') as MemoryScope
      if (!MEMORY_SCOPES.includes(scope)) throw new Error('记忆 scope 无效')
      const key = String(payload.key || '').trim().slice(0, 80)
      const value = String(payload.value || '').trim().slice(0, 2000)
      if (key.length < 2 || !value) throw new Error('记忆需要 key 与 value')
      const projectId = payload.projectId == null ? '' : String(payload.projectId).trim()
      const confidence = Number(payload.confidence)
      return {
        scope,
        key,
        value,
        ...(projectId ? { projectId } : {}),
        ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(0.95, confidence)) } : {}),
      }
    }
  }
}

export async function proposeAgentAction(input: {
  type: AgentActionType
  payload: Record<string, unknown>
  sessionId?: string | null
  turnId?: string | null
}): Promise<AgentActionView> {
  const payload = validateActionPayload(input.type, input.payload)
  const db = await getDb()
  const payloadJson = JSON.stringify(payload)
  const existing = await db.execute({
    sql: `SELECT * FROM agent_action WHERE type = ? AND payload_json = ? AND status = 'proposed'
          AND (expires_at IS NULL OR julianday(expires_at) >= julianday('now'))
          ORDER BY created_at DESC LIMIT 1`,
    args: [input.type, payloadJson],
  })
  if (existing.rows[0]) return mapAction(existing.rows[0] as unknown as Row)

  const id = crypto.randomUUID()
  const now = new Date()
  const expires = new Date(now.getTime() + ACTION_TTL_HOURS * 3600_000)
  await db.execute({
    sql: `INSERT INTO agent_action
            (id, session_id, turn_id, type, payload_json, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    args: [
      id,
      input.sessionId ?? null,
      input.turnId ?? null,
      input.type,
      payloadJson,
      now.toISOString(),
      expires.toISOString(),
    ],
  })
  return (await getAgentAction(id)) as AgentActionView
}

export async function getAgentAction(id: string): Promise<AgentActionView | null> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT * FROM agent_action WHERE id = ?', args: [id] })
  return res.rows[0] ? mapAction(res.rows[0] as unknown as Row) : null
}

export async function listAgentActions(opts: { status?: string; limit?: number } = {}): Promise<AgentActionView[]> {
  const db = await getDb()
  await db.execute({
    sql: `UPDATE agent_action SET status = 'expired', resolved_at = ?
          WHERE status = 'proposed' AND expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')`,
    args: [new Date().toISOString()],
  })
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30))
  const res = opts.status
    ? await db.execute({ sql: 'SELECT * FROM agent_action WHERE status = ? ORDER BY created_at DESC LIMIT ?', args: [opts.status, limit] })
    : await db.execute({ sql: 'SELECT * FROM agent_action ORDER BY created_at DESC LIMIT ?', args: [limit] })
  return (res.rows as unknown as Row[]).map(mapAction)
}

async function executeAction(action: AgentActionView): Promise<Record<string, unknown>> {
  const payload = action.payload
  switch (action.type) {
    case 'watch_event': {
      const code = str(payload.code)
      const title = str(payload.title) || str(payload.eventId) || code
      const note = str(payload.note).trim()
      if (code) {
        const db = await getDb()
        // 传 null 而不是兜底文案：空备注不能盖掉用户已写的备注。
        await db.execute({
          sql: `INSERT INTO watchlist_items (code, note, created_at) VALUES (?, ?, ?)
                ON CONFLICT(code) DO UPDATE SET note = COALESCE(NULLIF(excluded.note, ''), watchlist_items.note)`,
          args: [code, note || null, new Date().toISOString()],
        })
        if (!note) {
          await db.execute({
            sql: `UPDATE watchlist_items SET note = ? WHERE code = ? AND note IS NULL`,
            args: [`来自研究 Agent：${title}`, code],
          })
        }
      }
      await createNotification({
        id: `agent-action:${action.id}`,
        kind: 'agent_action',
        severity: 'info',
        title: `已关注：${title}`.slice(0, 200),
        body: note || '研究 Agent 提议的关注项已确认，后续可在研究台查看。',
        deepLink: '/analysis',
      })
      return { watched: true, code: code || null, eventId: str(payload.eventId) || null }
    }
    case 'create_task': {
      const task = await enqueueTask({
        type: payload.type as TaskType,
        params: sanitizeParams(payload.params),
      })
      if (task.status === 'queued') scheduleTaskDrain()
      return { taskId: task.id, status: task.status, type: task.type }
    }
    case 'pin_project': {
      const item = await addProjectItem({
        projectId: str(payload.projectId),
        kind: str(payload.kind) as ProjectItemKind,
        refId: str(payload.refId),
        title: str(payload.title) || undefined,
        note: str(payload.note) || undefined,
      })
      if (!item) throw new Error('研究项目不存在')
      return { pinned: true, projectId: str(payload.projectId), item }
    }
    case 'save_memory': {
      const memory = await upsertAgentMemory({
        scope: str(payload.scope, 'user') as MemoryScope,
        key: str(payload.key),
        value: str(payload.value),
        projectId: str(payload.projectId) || null,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
        sourceSessionId: action.sessionId ?? null,
      })
      return { memoryId: memory.id, scope: memory.scope, key: memory.key }
    }
  }
}

/** 确认后才执行；先条件更新抢占，避免双击或并发确认重复执行。 */
export async function resolveAgentAction(
  id: string,
  decision: 'confirm' | 'reject',
): Promise<AgentActionView | null> {
  const db = await getDb()
  const current = await getAgentAction(id)
  if (!current) return null
  if (current.status !== 'proposed') return current

  const now = new Date().toISOString()
  if (decision === 'reject') {
    await db.execute({
      sql: "UPDATE agent_action SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'proposed'",
      args: [now, id],
    })
    return getAgentAction(id)
  }

  const claimed = await db.execute({
    sql: `UPDATE agent_action SET status = 'confirmed', resolved_at = ?
          WHERE id = ? AND status = 'proposed'
            AND (expires_at IS NULL OR julianday(expires_at) >= julianday('now'))`,
    args: [now, id],
  })
  if (claimed.rowsAffected === 0) {
    await db.execute({
      sql: "UPDATE agent_action SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'proposed'",
      args: [now, id],
    })
    return getAgentAction(id)
  }

  try {
    const result = await executeAction(current)
    await db.execute({
      sql: "UPDATE agent_action SET result_json = ? WHERE id = ?",
      args: [JSON.stringify(result), id],
    })
    return getAgentAction(id)
  } catch (err) {
    await db.execute({
      sql: "UPDATE agent_action SET status = 'failed', error_message = ? WHERE id = ?",
      args: [(err as Error).message.slice(0, 500), id],
    })
    return getAgentAction(id)
  }
}
