/** 研究项目：把一组行业/个股与证据、判断、笔记装进同一上下文。 */
import crypto from 'crypto'
import { getDb } from '../db'

export type ProjectStatus = 'active' | 'archived'
export type ProjectItemKind = 'note' | 'evidence' | 'judgment' | 'document' | 'symbol'

export interface ProjectItemView {
  kind: ProjectItemKind
  refId: string
  title?: string
  note?: string
  createdAt: string
}

export interface AgentProjectView {
  id: string
  name: string
  thesis?: string
  status: ProjectStatus
  industries: string[]
  symbols: string[]
  items: ProjectItemView[]
  createdAt: string
  updatedAt: string
}

type Row = Record<string, unknown>

const KINDS: ProjectItemKind[] = ['note', 'evidence', 'judgment', 'document', 'symbol']

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

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 30)
    .map((item) => item.slice(0, 40))
}

function mapItem(row: Row): ProjectItemView {
  return {
    kind: str(row.kind) as ProjectItemKind,
    refId: str(row.ref_id),
    title: str(row.title) || undefined,
    note: str(row.note) || undefined,
    createdAt: str(row.created_at),
  }
}

function mapProject(row: Row, items: ProjectItemView[] = []): AgentProjectView {
  return {
    id: str(row.id),
    name: str(row.name),
    thesis: str(row.thesis) || undefined,
    status: str(row.status, 'active') as ProjectStatus,
    industries: parseJson<string[]>(row.industries_json, []),
    symbols: parseJson<string[]>(row.symbols_json, []),
    items,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  }
}

function validateName(name: unknown): string {
  const value = String(name || '').trim()
  if (value.length < 1 || value.length > 100) throw new Error('项目名称需为 1-100 字符')
  return value
}

/** 传 userId 时只看本账号与 legacy（NULL）项目；不传维持全局行为。 */
function ownerClause(userId?: number | null): { sql: string; args: number[] } {
  return userId != null
    ? { sql: ' AND (user_id = ? OR user_id IS NULL)', args: [userId] }
    : { sql: '', args: [] }
}

export async function listProjects(opts: { status?: string; limit?: number; userId?: number | null } = {}): Promise<AgentProjectView[]> {
  const db = await getDb()
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50))
  const status = opts.status === 'archived' ? 'archived' : opts.status === 'all' ? null : 'active'
  const owner = ownerClause(opts.userId)
  const res = status
    ? await db.execute({
        sql: `SELECT * FROM agent_project WHERE status = ?${owner.sql} ORDER BY updated_at DESC LIMIT ?`,
        args: [status, ...owner.args, limit],
      })
    : await db.execute({
        sql: `SELECT * FROM agent_project WHERE 1 = 1${owner.sql} ORDER BY updated_at DESC LIMIT ?`,
        args: [...owner.args, limit],
      })
  return (res.rows as unknown as Row[]).map((row) => mapProject(row))
}

export async function getProject(id: string, userId?: number | null): Promise<AgentProjectView | null> {
  const db = await getDb()
  const owner = ownerClause(userId)
  const res = await db.execute({
    sql: `SELECT * FROM agent_project WHERE id = ?${owner.sql}`,
    args: [id, ...owner.args],
  })
  const row = res.rows[0] as Row | undefined
  if (!row) return null
  const items = await db.execute({
    sql: 'SELECT * FROM agent_project_item WHERE project_id = ? ORDER BY created_at DESC',
    args: [id],
  })
  return mapProject(row, (items.rows as unknown as Row[]).map(mapItem))
}

export async function createProject(input: {
  name: string
  thesis?: string
  industries?: unknown
  symbols?: unknown
  userId?: number | null
}): Promise<AgentProjectView> {
  const db = await getDb()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT INTO agent_project
            (id, name, thesis, status, industries_json, symbols_json, created_at, updated_at, user_id)
          VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    args: [
      id,
      validateName(input.name),
      input.thesis ? String(input.thesis).trim().slice(0, 2000) : null,
      JSON.stringify(cleanList(input.industries)),
      JSON.stringify(cleanList(input.symbols)),
      now,
      now,
      input.userId ?? null,
    ],
  })
  return (await getProject(id, input.userId)) as AgentProjectView
}

export async function updateProject(id: string, patch: {
  name?: string
  thesis?: string | null
  status?: ProjectStatus
  industries?: unknown
  symbols?: unknown
}, userId?: number | null): Promise<AgentProjectView | null> {
  const current = await getProject(id, userId)
  if (!current) return null
  const db = await getDb()
  const status: ProjectStatus = patch.status === 'archived' ? 'archived' : patch.status === 'active' ? 'active' : current.status
  await db.execute({
    sql: `UPDATE agent_project SET name = ?, thesis = ?, status = ?, industries_json = ?, symbols_json = ?, updated_at = ?
          WHERE id = ?`,
    args: [
      patch.name === undefined ? current.name : validateName(patch.name),
      patch.thesis === undefined ? current.thesis ?? null : patch.thesis === null ? null : String(patch.thesis).trim().slice(0, 2000),
      status,
      JSON.stringify(patch.industries === undefined ? current.industries : cleanList(patch.industries)),
      JSON.stringify(patch.symbols === undefined ? current.symbols : cleanList(patch.symbols)),
      new Date().toISOString(),
      id,
    ],
  })
  return getProject(id, userId)
}

export async function addProjectItem(input: {
  projectId: string
  kind: ProjectItemKind
  refId: string
  title?: string
  note?: string
  userId?: number | null
}): Promise<ProjectItemView | null> {
  if (!KINDS.includes(input.kind)) throw new Error('项目条目类型无效')
  const refId = String(input.refId || '').trim()
  if (!refId || refId.length > 200) throw new Error('条目 refId 需为 1-200 字符')
  const project = await getProject(input.projectId, input.userId)
  if (!project) return null
  const db = await getDb()
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT INTO agent_project_item (project_id, kind, ref_id, title, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, kind, ref_id) DO UPDATE SET
            title = excluded.title, note = excluded.note`,
    args: [
      input.projectId,
      input.kind,
      refId,
      input.title ? String(input.title).trim().slice(0, 200) : null,
      input.note ? String(input.note).trim().slice(0, 1000) : null,
      now,
    ],
  })
  await db.execute({ sql: 'UPDATE agent_project SET updated_at = ? WHERE id = ?', args: [now, input.projectId] })
  const res = await db.execute({
    sql: 'SELECT * FROM agent_project_item WHERE project_id = ? AND kind = ? AND ref_id = ?',
    args: [input.projectId, input.kind, refId],
  })
  return res.rows[0] ? mapItem(res.rows[0] as unknown as Row) : null
}

export async function removeProjectItem(
  projectId: string,
  kind: ProjectItemKind,
  refId: string,
  userId?: number | null,
): Promise<boolean> {
  if (!(await getProject(projectId, userId))) return false
  const db = await getDb()
  const res = await db.execute({
    sql: 'DELETE FROM agent_project_item WHERE project_id = ? AND kind = ? AND ref_id = ?',
    args: [projectId, kind, refId],
  })
  if (res.rowsAffected > 0) {
    await db.execute({ sql: 'UPDATE agent_project SET updated_at = ? WHERE id = ?', args: [new Date().toISOString(), projectId] })
  }
  return res.rowsAffected > 0
}

export async function projectContext(projectId: string, userId?: number | null): Promise<string> {
  const project = await getProject(projectId, userId)
  if (!project) return ''
  const lines = [
    `研究项目：${project.name}`,
    project.thesis ? `论点：${project.thesis}` : '',
    project.industries.length ? `行业：${project.industries.join('、')}` : '',
    project.symbols.length ? `个股：${project.symbols.join('、')}` : '',
    project.items.length
      ? `关联条目：\n${project.items.slice(0, 12).map((item) => `- [${item.kind}] ${item.title || item.refId}${item.note ? `｜${item.note}` : ''}`).join('\n')}`
      : '',
  ]
  return lines.filter(Boolean).join('\n')
}
