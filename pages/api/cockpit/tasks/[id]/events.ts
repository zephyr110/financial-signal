import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryString, sendError } from '../../../../../lib/cockpit/api'
import { getTask, getTaskEvents } from '../../../../../lib/cockpit/tasks'

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

/** SSE：1 秒轮询数据库，15 秒心跳；任务终止后发送 done 并关闭。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  const id = queryString(req.query.id)
  if (!id) return sendError(req, res, 400, 'INVALID_ID', '任务 ID 无效')
  const initial = await getTask(id)
  if (!initial) return sendError(req, res, 404, 'TASK_NOT_FOUND', '任务不存在')

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write('retry: 3000\n\n')

  let seq = 0
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  function cleanup() {
    if (timer) clearInterval(timer)
    if (heartbeat) clearInterval(heartbeat)
    timer = null
    heartbeat = null
  }

  function writeEvent(type: string, data: unknown) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  async function poll() {
    if (closed) return
    try {
      const events = await getTaskEvents(id, seq)
      for (const event of events) {
        seq = Math.max(seq, event.seq)
        writeEvent('task-event', event)
      }
      const task = await getTask(id)
      if (!task) {
        writeEvent('error', { message: '任务不存在' })
        cleanup()
        closed = true
        res.end()
        return
      }
      writeEvent('task', task)
      if (TERMINAL.has(task.status)) {
        writeEvent('done', { status: task.status })
        cleanup()
        closed = true
        res.end()
      }
    } catch (err) {
      writeEvent('error', { message: '任务事件读取失败' })
      cleanup()
      closed = true
      res.end()
    }
  }

  timer = setInterval(() => { void poll() }, 1000)
  heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 15000)
  req.on('close', () => {
    closed = true
    cleanup()
  })
  await poll()
}
