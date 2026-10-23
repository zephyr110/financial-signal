import crypto from 'crypto'
import { getDb } from '../db'
import type { NotificationRecord, NotificationSeverity } from './types'

type Row = Record<string, unknown>

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function mapNotification(row: Row): NotificationRecord {
  return {
    id: str(row.id),
    kind: str(row.kind),
    severity: str(row.severity) as NotificationSeverity,
    title: str(row.title),
    body: str(row.body) || undefined,
    deepLink: str(row.deep_link) || undefined,
    readAt: str(row.read_at) || undefined,
    createdAt: str(row.created_at),
  }
}

/**
 * 通知用调用方给的稳定 id 去重；相同任务重试或 cron 重复执行不会刷屏。
 * 通知失败不应影响主流程，调用方负责吞掉异常。
 */
export async function createNotification(input: {
  id?: string
  kind: string
  severity?: NotificationSeverity
  title: string
  body?: string | null
  deepLink?: string | null
}): Promise<NotificationRecord> {
  const db = await getDb()
  const id = input.id || crypto.randomUUID()
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT OR IGNORE INTO notifications
          (id, kind, severity, title, body, deep_link, read_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    args: [
      id,
      input.kind,
      input.severity || 'info',
      input.title.slice(0, 200),
      input.body ? input.body.slice(0, 1000) : null,
      input.deepLink || null,
      now,
    ],
  })
  const res = await db.execute({ sql: 'SELECT * FROM notifications WHERE id = ?', args: [id] })
  if (!res.rows[0]) throw new Error('通知写入失败')
  return mapNotification(res.rows[0] as unknown as Row)
}

export async function listNotifications(limit = 20): Promise<{ items: NotificationRecord[]; unread: number }> {
  const db = await getDb()
  const safeLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 20))
  const [itemsRes, unreadRes] = await Promise.all([
    db.execute({
      sql: 'SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?',
      args: [safeLimit],
    }),
    db.execute({ sql: 'SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL', args: [] }),
  ])
  return {
    items: (itemsRes.rows as unknown as Row[]).map(mapNotification),
    unread: Number(unreadRes.rows[0]?.n || 0),
  }
}

export async function markNotificationRead(id: string): Promise<boolean> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL',
    args: [new Date().toISOString(), id],
  })
  return Number(res.rowsAffected) > 0
}

export async function markAllNotificationsRead(): Promise<number> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'UPDATE notifications SET read_at = ? WHERE read_at IS NULL',
    args: [new Date().toISOString()],
  })
  return Number(res.rowsAffected)
}
