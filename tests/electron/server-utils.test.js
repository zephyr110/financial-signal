import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { findFreePort, waitForHealthy } from '../../electron/server-utils'

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
})
