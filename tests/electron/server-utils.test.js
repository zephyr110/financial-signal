import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { findFreePort, waitForHealthy, buildServerEnv } from '../../electron/server-utils'

describe('findFreePort', () => {
  it('returns a port that is actually listenable', async () => {
    const port = await findFreePort()
    expect(typeof port).toBe('number')
    await new Promise((resolve, reject) => {
      const srv = http.createServer()
      srv.listen(port, '127.0.0.1', () => { srv.close(() => resolve()) })
      srv.on('error', reject)
    })
  })

  it('avoids an already-bound port', async () => {
    const taken = await findFreePort()
    const srv = http.createServer()
    await new Promise((r) => srv.listen(taken, '127.0.0.1', r))
    const next = await findFreePort()
    expect(next).not.toBe(taken)
    await new Promise((r) => srv.close(r))
  })
})

describe('waitForHealthy', () => {
  let srv
  let port
  beforeAll(async () => {
    port = await findFreePort()
    srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise((r) => srv.listen(port, '127.0.0.1', r))
  })
  afterAll(async () => { if (srv) await new Promise((r) => srv.close(r)) })

  it('resolves when the URL starts returning', async () => {
    const ok = await waitForHealthy(`http://127.0.0.1:${port}`, { timeoutMs: 3000, intervalMs: 50 })
    expect(ok).toBe(true)
  })

  it('times out for a dead port', async () => {
    const dead = await findFreePort()
    const ok = await waitForHealthy(`http://127.0.0.1:${dead}`, { timeoutMs: 400, intervalMs: 50 })
    expect(ok).toBe(false)
  })

  it('recovers after transient 5xx during boot', async () => {
    let count = 0
    const flakyPort = await findFreePort()
    const flaky = http.createServer((req, res) => {
      count += 1
      if (count <= 2) {
        res.statusCode = 503
        res.end('starting')
      } else {
        res.statusCode = 200
        res.end('ok')
      }
    })
    await new Promise((r) => flaky.listen(flakyPort, '127.0.0.1', r))
    const ok = await waitForHealthy(`http://127.0.0.1:${flakyPort}`, { timeoutMs: 3000, intervalMs: 50 })
    await new Promise((r) => flaky.close(r))
    expect(ok).toBe(true)
  })
})

describe('buildServerEnv', () => {
  it('forces PORT/HOSTNAME/DESKTOP_MODE/NODE_ENV and sets NEWS_DB_PATH + AUTH_DB_PATH', () => {
    const env = buildServerEnv({ port: 8123, dbPath: '/tmp/x.db' })
    expect(env.PORT).toBe('8123')
    expect(env.HOSTNAME).toBe('127.0.0.1')
    expect(env.DESKTOP_MODE).toBe('1')
    expect(env.NODE_ENV).toBe('production')
    expect(env.NEWS_DB_PATH).toBe('/tmp/x.db')
    expect(env.AUTH_DB_PATH).toBe('/tmp/auth.db')
  })

  it('omits NEWS_DB_PATH when dbPath falsy, and extra overrides', () => {
    const env = buildServerEnv({ port: 1, extra: { EXTRA_VAR: 'x', NODE_ENV: 'custom' } })
    expect(env.NEWS_DB_PATH).toBeUndefined()
    expect(env.EXTRA_VAR).toBe('x')
    expect(env.NODE_ENV).toBe('custom')
  })

  it('不泄漏宿主 env:TURSO 凭据不进子进程,LLM 配置照常透传', () => {
    const saved = { turso: process.env.TURSO_DATABASE_URL, llm: process.env.LLM_API_KEY }
    process.env.TURSO_DATABASE_URL = 'libsql://leak-me.turso.io'
    process.env.LLM_API_KEY = 'sk-env-llm'
    try {
      const env = buildServerEnv({ port: 1 })
      expect(env.TURSO_DATABASE_URL).toBeUndefined() // 防桌面端静默重定向到用户远程 Turso
      expect(env.LLM_API_KEY).toBe('sk-env-llm') // 白名单内的 LLM 配置需要传给子进程
    } finally {
      if (saved.turso === undefined) delete process.env.TURSO_DATABASE_URL
      else process.env.TURSO_DATABASE_URL = saved.turso
      if (saved.llm === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.llm
    }
  })
})
