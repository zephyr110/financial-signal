import { describe, it, expect, vi, afterEach } from 'vitest'
import http from 'http'
import { createScheduler, callCron } from '../../electron/scheduler'
import { findFreePort } from '../../electron/server-utils'

/**
 * 调度器核心逻辑测试:用本地 http server 记录收到的请求。
 * 注:standalone 的 cron 路由是 GET(/api/cron/<job>,见 pages/api/cron/*),callCron 保持 GET。
 */

const servers = []

async function startServer(handler) {
  const srv = http.createServer(handler)
  const sockets = new Set()
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  servers.push({ srv, sockets })
  return { srv, sockets, port: srv.address().port }
}

afterEach(async () => {
  while (servers.length) {
    const { srv, sockets } = servers.pop()
    for (const s of sockets) s.destroy()
    await new Promise((r) => srv.close(r))
  }
})

function waitUntil(pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve() }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('waitUntil timeout')) }
    }, 10)
  })
}

describe('callCron', () => {
  it('GETs the correct path and resolves true on 2xx', async () => {
    const paths = []
    const { port } = await startServer((req, res) => {
      paths.push(req.url)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await expect(callCron(`http://127.0.0.1:${port}`, 'fetch')).resolves.toBe(true)
    await expect(callCron(`http://127.0.0.1:${port}`, 'deep-analyze')).resolves.toBe(true)
    expect(paths).toEqual(['/api/cron/fetch', '/api/cron/deep-analyze'])
  })

  it('resolves false on non-2xx status', async () => {
    const { port } = await startServer((req, res) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: 'boom' }))
    })
    await expect(callCron(`http://127.0.0.1:${port}`, 'fetch')).resolves.toBe(false)
  })

  it('rejects with a timeout error when the endpoint hangs', async () => {
    const { port } = await startServer(() => {}) // 收到请求但不响应
    await expect(callCron(`http://127.0.0.1:${port}`, 'fetch', { timeoutMs: 100 }))
      .rejects.toThrow('cron fetch timeout')
  })

  it('rejects when the connection is refused', async () => {
    const deadPort = await findFreePort()
    await expect(callCron(`http://127.0.0.1:${deadPort}`, 'fetch')).rejects.toThrow()
  })
})

describe('createScheduler', () => {
  function makeScheduler({ port, intervalMs = 60000, getSettings } = {}) {
    return createScheduler({
      baseUrl: `http://127.0.0.1:${port}`,
      getConfig: () => ({ intervalMs, notifyLastRunAt: null }),
      getSettings: getSettings || (async () => ({})),
    })
  }

  it('runOnce is not re-entrant while a run is in flight', async () => {
    // http handler 挂起不响应 → runOnce 卡在 callCron 上
    const { port, sockets } = await startServer(() => {})
    const scheduler = makeScheduler({ port })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = scheduler.runOnce() // 第一轮挂起在 http 请求上
      await new Promise((r) => setTimeout(r, 20)) // 等第一轮的连接建立
      const second = scheduler.runOnce() // 第二轮应立即返回(guard 生效)
      await second // 立刻 resolve,不等待第一轮
      expect(sockets.size).toBe(1) // 未发起第二轮 http 请求
      // 不 await first:它要等 afterEach 销毁连接后才会结束
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('start() runs immediately, then on each interval until stop()', async () => {
    const paths = []
    const { port } = await startServer((req, res) => {
      paths.push(req.url)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    const scheduler = makeScheduler({ port, intervalMs: 50 })
    await scheduler.start() // 等待立即首轮完成
    expect(paths.filter((p) => p === '/api/cron/fetch')).toHaveLength(1)

    await waitUntil(() => paths.length >= 3) // 两个间隔轮
    scheduler.stop()
    await new Promise((r) => setTimeout(r, 150)) // 让可能的在途请求完成
    const count = paths.length
    await new Promise((r) => setTimeout(r, 200))
    expect(paths.length).toBe(count) // stop 后不再触发
  })

  it('stop() is idempotent and does not break a later start()', async () => {
    const paths = []
    const { port } = await startServer((req, res) => {
      paths.push(req.url)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    const scheduler = makeScheduler({ port, intervalMs: 50 })
    scheduler.stop()
    scheduler.stop() // 未启动时 stop 也应安全
    await scheduler.start()
    await waitUntil(() => paths.length >= 2)
    scheduler.stop()
    scheduler.stop()
    await new Promise((r) => setTimeout(r, 150))
    const count = paths.length
    await new Promise((r) => setTimeout(r, 200))
    expect(paths.length).toBe(count) // 二次 stop 后不再触发
  })
})
