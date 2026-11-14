/**
 * 研究 Agent 长期记忆：用户偏好、项目约束、行业/个股结论。
 * 只注入短摘要；原文留在库里，避免撑爆上下文。
 */
import crypto from 'crypto'
import { getDb } from '../db'

export type MemoryScope = 'user' | 'project' | 'industry' | 'symbol'
export type MemoryStatus = 'active' | 'decayed' | 'deleted'

export interface AgentMemoryView {
  id: string
  scope: MemoryScope
  projectId?: string
  key: string
  value: string
  confidence: number
  sourceSessionId?: string
  status: MemoryStatus
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

type Row = Record<string, unknown>

const SCOPES: MemoryScope[] = ['user', 'project', 'industry', 'symbol']

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function mapMemory(row: Row): AgentMemoryView {
  return {
    id: str(row.id),
    scope: str(row.scope) as MemoryScope,
    projectId: str(row.project_id) || undefined,
    key: str(row.key),
    value: str(row.value),
    confidence: num(row.confidence, 0.5),
    sourceSessionId: str(row.source_session_id) || undefined,
    status: str(row.status, 'active') as MemoryStatus,
    expiresAt: str(row.expires_at) || undefined,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  }
}

export interface UpsertMemoryInput {
  scope: MemoryScope
  key: string
  value: string
  projectId?: string | null
  confidence?: number
  sourceSessionId?: string | null
  expiresAt?: string | null
}

function validateMemory(input: UpsertMemoryInput): { scope: MemoryScope; key: string; value: string } {
  if (!SCOPES.includes(input.scope)) throw new Error('记忆 scope 无效')
  const key = input.key.trim()
  const value = input.value.trim()
  if (key.length < 2 || key.length > 80) throw new Error('记忆 key 需为 2-80 字符')
  if (!value || value.length > 2000) throw new Error('记忆内容需为 1-2000 字符')
  if (input.scope === 'project' && !input.projectId) throw new Error('项目记忆需要 projectId')
  return { scope: input.scope, key, value }
}

/** 项目记忆写入同一个 UNIQUE(scope,key)，key 内嵌项目 ID 避免跨项目覆盖。 */
function storageKey(scope: MemoryScope, projectId: string | null | undefined, key: string): string {
  return scope === 'project' && projectId ? `project:${projectId}:${key}` : key
}

/** 到期记忆降级而非删除：保留可追溯性，但不再注入 prompt。 */
export async function decayExpiredMemories(): Promise<number> {
  const db = await getDb()
  const res = await db.execute({
    sql: `UPDATE agent_memory SET status = 'decayed'
          WHERE status = 'active' AND expires_at IS NOT NULL AND julianday(expires_at) < julianday('now')`,
    args: [],
  })
  return res.rowsAffected
}

export async function upsertAgentMemory(input: UpsertMemoryInput): Promise<AgentMemoryView> {
  const { scope, key, value } = validateMemory(input)
  const db = await getDb()
  const now = new Date().toISOString()
  const confidence = Math.max(0, Math.min(0.95, input.confidence ?? 0.5))
  const keyForStorage = storageKey(scope, input.projectId, key)
  const id = crypto.randomUUID()

  await db.execute({
    sql: `INSERT INTO agent_memory
            (id, scope, project_id, key, value, confidence, source_session_id, status, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
          ON CONFLICT(scope, key) DO UPDATE SET
            value = excluded.value,
            confidence = excluded.confidence,
            project_id = excluded.project_id,
            source_session_id = COALESCE(excluded.source_session_id, agent_memory.source_session_id),
            expires_at = excluded.expires_at,
            status = 'active',
            updated_at = excluded.updated_at`,
    args: [
      id,
      scope,
      input.projectId ?? null,
      keyForStorage,
      value,
      confidence,
      input.sourceSessionId ?? null,
      input.expiresAt ?? null,
      now,
      now,
    ],
  })
  const res = await db.execute({ sql: 'SELECT * FROM agent_memory WHERE scope = ? AND key = ?', args: [scope, keyForStorage] })
  if (!res.rows[0]) throw new Error('记忆写入失败')
  return mapMemory(res.rows[0] as unknown as Row)
}

export async function listAgentMemories(opts: {
  scope?: string
  status?: string
  limit?: number
} = {}): Promise<AgentMemoryView[]> {
  await decayExpiredMemories()
  const db = await getDb()
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30))
  const conditions: string[] = []
  const args: unknown[] = []
  if (opts.scope) {
    if (!SCOPES.includes(opts.scope as MemoryScope)) throw new Error('记忆 scope 无效')
    conditions.push('scope = ?')
    args.push(opts.scope)
  }
  if (opts.status) {
    conditions.push('status = ?')
    args.push(opts.status)
  } else {
    conditions.push("status = 'active'")
  }
  args.push(limit)
  const res = await db.execute({
    sql: `SELECT * FROM agent_memory WHERE ${conditions.join(' AND ')}
          ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
    args,
  })
  return (res.rows as unknown as Row[]).map(mapMemory)
}

export async function deleteAgentMemory(id: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.execute({
    sql: "UPDATE agent_memory SET status = 'deleted', updated_at = ? WHERE id = ? AND status <> 'deleted'",
    args: [new Date().toISOString(), id],
  })
  return res.rowsAffected > 0
}

/** 注入 system prompt 的短记忆清单；没有记忆时返回空串。 */
export async function loadAgentMemoryPrompt(limit = 12): Promise<string> {
  try {
    const memories = await listAgentMemories({ limit })
    if (!memories.length) return ''
    return memories
      .map((memory) => `- [${memory.scope}] ${memory.key}: ${memory.value.slice(0, 240)}（置信度 ${memory.confidence.toFixed(2)}）`)
      .join('\n')
  } catch {
    // 记忆是增强项，读取失败不能阻断研究回合
    return ''
  }
}
