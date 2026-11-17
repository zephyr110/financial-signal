import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import proxy from '../proxy'
import { getSessionUser } from '../lib/auth'

vi.mock('../lib/auth', () => ({
  SESSION_COOKIE: 'fs_session',
  getSessionUser: vi.fn(),
}))

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'))
  vi.stubEnv('DESKTOP_MODE', '1')
  vi.stubEnv('NEWS_DB_PATH', path.join(dir, 'news_archive.db'))
  vi.stubEnv('DB_CONFIG_PATH', path.join(dir, 'db-config.json'))
  vi.mocked(getSessionUser).mockReset()
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function request(pathname: string) {
  return new NextRequest(`http://127.0.0.1:3010${pathname}`)
}

describe('proxy 登录门卫', () => {
  it('调度器探测端点免会话（路由自身校验 DESKTOP_MODE + 本机 Origin）', async () => {
    const res = await proxy(request('/api/desktop/runtime'))
    expect(res.status).toBe(200)
    expect(getSessionUser).not.toHaveBeenCalled()
  })

  it('本地库尚未创建时放行首页（桌面首启欢迎页）', async () => {
    const res = await proxy(request('/'))
    expect(res.status).toBe(200)
  })

  it('已配置 Turso 时首启放行不生效（远端库本就没有本地文件）', async () => {
    fs.writeFileSync(
      path.join(dir, 'db-config.json'),
      JSON.stringify({ backend: 'turso', tursoUrl: 'libsql://db.turso.io' }),
    )
    const res = await proxy(request('/'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login?next=%2F')
  })
})
