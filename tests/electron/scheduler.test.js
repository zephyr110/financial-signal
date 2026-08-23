import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createScheduler, callCron } from '../../electron/scheduler'
import { PIPELINE_JOBS } from '../../electron/scheduler-core'
import { findFreePort } from '../../electron/server-utils'

/**
 * 调度器核心逻辑测试:用本地 http server 记录收到的请求。
 * 注:standalone 的 cron 路由是 GET(/api/cron/<job>,见 pages/api/cron/*),callCron 保持 GET。
 * 新调度器行为:db 文件不存在 → no-db 短路(欢迎页门控);首轮延迟 firstRunDelayMs;
 * 单 job 失败不中断本轮;onRunEnd 无论成败都调用。
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

let dir, dbPath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'))
  dbPath = path.join(dir, 'news_archive.db')
  fs.writeFileSync(dbPath, '') // 存在即可:调度器只看文件是否创建(欢迎页门控)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('callCron', () => {
  it('GETs the correct path with a local Origin header and resolves true on 2xx', async () => {
    const reqs = []
    const { port } = await startServer((req, res) => {
      reqs.push({ url: req.url, origin: req.headers.origin })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await expect(callCron(`http://127.0.0.1:${port}`, 'fetch')).resolves.toBe(true)
    await expect(callCron(`http://127.0.0.1:${port}`, 'deep-analyze')).resolves.toBe(true)
    expect(reqs).toEqual([
      { url: '/api/cron/fetch', origin: `http://127.0.0.1:${port}` },
      { url: '/api/cron/deep-analyze', origin: `http://127.0.0.1:${port}` },
    ])
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
  function makeScheduler({ port, intervalMs = 60000, getSettings, dbPath: db = dbPath, onRunEnd } = {}) {
    return createScheduler({
      baseUrl: `http://127.0.0.1:${port}`,
      dbPath: db,
      configFile: path.join(dir, 'config.json'),
      getConfig: () => ({ intervalMs, notifyLastRunAt: null }),
      getSettings: getSettings || (async () => ({})),
      onRunEnd,
      firstRunDelayMs: 20, // 测试注入:不等待默认 15s
      minIntervalMs: 10,
    })
  }

  it('runOnce is not re-entrant while a run is in flight', async () => {
    // http handler 挂起不响应 → runOnce 卡在 callCron 上
    const { port, sockets } = await startServer(() => {})
    const scheduler = makeScheduler({ port })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = scheduler.runOnce() // 第一轮挂起在 http 请求上
      first.catch(() => {}) // 挂起轮由 afterEach 销毁连接终止,吞掉其 rejection
      await new Promise((r) => setTimeout(r, 20)) // 等第一轮的连接建立
      const second = await scheduler.runOnce() // 第二轮应立即返回 'running'(guard 生效)
      expect(second).toBe('running')
      expect(sockets.size).toBe(1) // 未发起第二轮 http 请求
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('returns no-db without making any request when the db file does not exist (welcome-page gate)', async () => {
    const paths = []
    const { port } = await startServer((req, res) => { paths.push(req.url); res.end('{}') })
    const scheduler = makeScheduler({ port, dbPath: path.join(dir, 'nope.db') })
    expect(await scheduler.runOnce()).toBe('no-db')
    expect(paths).toHaveLength(0) // 绝不请求 /api/cron/*(防抢先建库)
  })

  it('LLM 未配置时只跑 fetch;已配置时跑完整管线', async () => {
    // 宿主 shell 可能导出 LLM/DEEPSEEK key,isLlmConfigured 会走 env 回退 → 必须隔离
    const saved = { llm: process.env.LLM_API_KEY, deep: process.env.DEEPSEEK_API_KEY }
    delete process.env.LLM_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const paths = []
      const { port } = await startServer((req, res) => { paths.push(req.url); res.end('{}') })
      const fetchOnly = makeScheduler({ port })
      await fetchOnly.runOnce()
      expect(paths).toEqual(['/api/cron/fetch'])

      paths.length = 0
      const full = makeScheduler({ port, getSettings: async () => ({ llm_api_key: 'sk-xxx' }) })
      await full.runOnce()
      expect(paths).toEqual(PIPELINE_JOBS.map((j) => `/api/cron/${j}`))
    } finally {
      if (saved.llm === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.llm
      if (saved.deep === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved.deep
    }
  })

  it('start() runs after the first-run delay, then on each interval until stop()', async () => {
    const paths = []
    const { port } = await startServer((req, res) => {
      paths.push(req.url)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    const scheduler = makeScheduler({ port, intervalMs: 50 })
    scheduler.start()
    await waitUntil(() => paths.length >= 1) // 首轮在 firstRunDelayMs(20ms)后执行
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
    scheduler.start()
    await waitUntil(() => paths.length >= 2)
    scheduler.stop()
    scheduler.stop()
    await new Promise((r) => setTimeout(r, 150))
    const count = paths.length
    await new Promise((r) => setTimeout(r, 200))
    expect(paths.length).toBe(count) // 二次 stop 后不再触发
  })

  it('单个 job 失败不中断本轮:后续 job 照常执行,onRunEnd 仍被调用', async () => {
    const paths = []
    const { port } = await startServer((req, res) => {
      paths.push(req.url)
      res.statusCode = req.url.includes('fetch') ? 500 : 200
      res.end('{}')
    })
    const onRunEnd = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const scheduler = makeScheduler({ port, getSettings: async () => ({ llm_api_key: 'sk' }), onRunEnd })
    try {
      await scheduler.runOnce() // 不抛:失败被单 job 捕获
      expect(paths).toEqual(PIPELINE_JOBS.map((j) => `/api/cron/${j}`))
      expect(onRunEnd).toHaveBeenCalledTimes(1)
    } finally {
      logSpy.mockRestore()
    }
  })

  it('onRunEnd 在整轮失败时也被调用(失败不挂起调度器)', async () => {
    const { port } = await startServer((req, res) => { res.end('{}') })
    const onRunEnd = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scheduler = makeScheduler({ port, getSettings: async () => { throw new Error('settings boom') }, onRunEnd })
    try {
      await scheduler.runOnce() // runOnce 内部已 catch,不向外抛
      expect(onRunEnd).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
