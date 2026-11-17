import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Module from 'node:module'
import { createClient } from '@libsql/client'

// ipc.js 是 CJS,内部 require('electron') 走 node 原生 require,vi.mock 拦不到
// (真实 electron 包导出的只是可执行文件路径字符串)。这里在模块级挂 Module._load 钩子,
// 在动态 import ipc.js 之前把 electron 换成桩——与主进程验证 harness 同一手法。
const handlers = {}
const electronStub = {
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn } },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  app: { isPackaged: true, getVersion: () => '9.9.9-test' },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

const { registerIpc } = await import('../../electron/ipc')

let dir, dbPath
const deps = { onImported: null, onFreshDb: null }

/** 模拟本应用页面发来的 IPC event(受信 sender)。 */
function trustedEvent() {
  return {
    senderFrame: { url: 'http://127.0.0.1:3010/' },
    sender: { getURL: () => 'http://127.0.0.1:3010/' },
  }
}
/** 模拟第三方页面发来的 IPC event(非受信 sender)。 */
function untrustedEvent() {
  return {
    senderFrame: { url: 'https://evil.example.com/' },
    sender: { getURL: () => 'https://evil.example.com/' },
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'))
  dbPath = path.join(dir, 'news_archive.db')
  electronStub.app.isPackaged = true
  deps.onImported = null
  deps.onFreshDb = null
  registerIpc({
    getDbPath: () => dbPath,
    onImported: () => (deps.onImported ? deps.onImported() : Promise.resolve()),
    onFreshDb: () => (deps.onFreshDb ? deps.onFreshDb() : Promise.resolve({ ok: true })),
    onFetchNow: null,
  })
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('app:get-info imported 谓词(I1)', () => {
  it('prod:db 不存在 → imported=false', async () => {
    const r = await handlers['app:get-info'](trustedEvent())
    expect(r.imported).toBe(false)
  })

  it('prod:0 字节空库(未初始化)→ imported=false(关键:抢先建出的空库不能跳过欢迎页)', async () => {
    fs.writeFileSync(dbPath, '')
    const r = await handlers['app:get-info'](trustedEvent())
    expect(r.imported).toBe(false)
  })

  it('prod:含必要表的 db → imported=true', async () => {
    const db = createClient({ url: `file:${dbPath}` })
    await db.executeMultiple(`
      CREATE TABLE news_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    `)
    await db.close()
    const r = await handlers['app:get-info'](trustedEvent())
    expect(r.imported).toBe(true)
  })

  it('dev:userData 有 db 文件即 imported=true(existsSync 语义)', async () => {
    // ipc.js 在模块级快照 isDev = !app.isPackaged,dev 分支需重置模块后重载
    electronStub.app.isPackaged = false
    vi.resetModules()
    const { registerIpc: registerDev } = await import('../../electron/ipc')
    registerDev({
      getDbPath: () => dbPath,
      onImported: () => Promise.resolve(),
      onFreshDb: () => Promise.resolve({ ok: true }),
      onFetchNow: null,
    })
    fs.writeFileSync(dbPath, '') // dev 下空文件也视为已导入(dev 无 server 建表,文件只可能来自 createFreshDb)
    const r = await handlers['app:get-info'](trustedEvent())
    expect(r.imported).toBe(true)
  })
})

describe('db 变更后重启失败的错误传播(I1b)', () => {
  it('createFreshDb 后重启失败 → {ok:false, error},且后续导入仍可执行', async () => {
    // 第一次:onFreshDb 抛错(模拟 restartAfterDbChange 重启失败后 app.quit)
    deps.onFreshDb = async () => { throw new Error('restart boom') }
    const r1 = await handlers['app:create-fresh-db'](trustedEvent())
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('restart boom')

    // 第二次:重启恢复,importChain 未被失败挂死,仍返回 {ok:true}
    deps.onFreshDb = async () => { await Promise.resolve(); return { ok: true } }
    const r2 = await handlers['app:create-fresh-db'](trustedEvent())
    expect(r2.ok).toBe(true)
  })

  it('导入成功但重启失败 → {ok:false, error},且后续导入仍可执行', async () => {
    // 先造一个合法源库
    const src = path.join(dir, 'src.db')
    const db = createClient({ url: `file:${src}` })
    await db.executeMultiple(`
      CREATE TABLE news_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    `)
    await db.close()
    electronStub.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [src],
    })
    deps.onImported = async () => { throw new Error('server down') }

    const r1 = await handlers['app:select-and-import-db'](trustedEvent())
    expect(r1.ok).toBe(false)
    expect(r1.error).toContain('server down')
    // 文件本身已原子替换到位(失败在重启阶段,不在复制阶段)
    expect(fs.existsSync(dbPath)).toBe(true)

    // 链未挂死:后续 fresh-db 正常
    deps.onImported = null
    const r2 = await handlers['app:create-fresh-db'](trustedEvent())
    expect(r2.ok).toBe(true)
  })
})

describe('IPC sender 校验(I3):非本应用页面一律拒绝', () => {
  it('untrusted sender 的 get-info 返回 Forbidden,不泄露 dbPath', async () => {
    const r = await handlers['app:get-info'](untrustedEvent())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Forbidden')
    expect(r.dbPath).toBeUndefined()
  })

  it('untrusted sender 的 fetch-now 被拒绝(不触发 LLM 管线)', async () => {
    const onFetchNow = vi.fn()
    electronStub.app.isPackaged = false
    vi.resetModules()
    const { registerIpc: registerTrusted } = await import('../../electron/ipc')
    registerTrusted({
      getDbPath: () => dbPath,
      onImported: () => Promise.resolve(),
      onFreshDb: () => Promise.resolve({ ok: true }),
      onFetchNow,
    })
    const r = await handlers['app:fetch-now'](untrustedEvent())
    expect(r.ok).toBe(false)
    expect(onFetchNow).not.toHaveBeenCalled()
  })

  it('缺失 event(异常路径)按不信任处理', async () => {
    const r = await handlers['app:get-info']()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Forbidden')
  })
})

describe('scheduler IPC', () => {
  function registerWithScheduler(setSchedulerConfig) {
    let cfg = { enabled: true, intervalMs: 30 * 60 * 1000 }
    registerIpc({
      getDbPath: () => dbPath,
      onImported: () => Promise.resolve(),
      onFreshDb: () => Promise.resolve({ ok: true }),
      onFetchNow: null,
      getSchedulerConfig: () => cfg,
      setSchedulerConfig: (patch) => {
        cfg = setSchedulerConfig(patch, cfg)
        return cfg
      },
    })
    return () => cfg
  }

  it('get/set 转发注入的配置并返回最新值', async () => {
    const getCfg = registerWithScheduler((patch, cfg) => (
      typeof patch.enabled === 'boolean' ? { ...cfg, enabled: patch.enabled } : cfg
    ))
    expect(await handlers['app:get-scheduler'](trustedEvent()))
      .toEqual({ ok: true, enabled: true, intervalMs: 30 * 60 * 1000 })
    expect(await handlers['app:set-scheduler'](trustedEvent(), { enabled: false }))
      .toEqual({ ok: true, enabled: false, intervalMs: 30 * 60 * 1000 })
    expect(getCfg().enabled).toBe(false)
  })

  it('untrusted sender 拒绝,不修改配置', async () => {
    const setSchedulerConfig = vi.fn((patch, cfg) => cfg)
    registerWithScheduler(setSchedulerConfig)
    const r = await handlers['app:set-scheduler'](untrustedEvent(), { enabled: false })
    expect(r).toEqual({ ok: false, error: 'Forbidden' })
    expect(setSchedulerConfig).not.toHaveBeenCalled()
  })

  it('set 抛错时返回 ok:false + 错误信息', async () => {
    registerWithScheduler(() => { throw new Error('调度间隔不合法') })
    const r = await handlers['app:set-scheduler'](trustedEvent(), { intervalMinutes: 1 })
    expect(r).toEqual({ ok: false, error: '调度间隔不合法' })
  })

  it('文件系统错误不回传绝对路径', async () => {
    registerWithScheduler(() => {
      throw new Error("EACCES: permission denied, open '/Users/someone/Library/Application Support/scheduler.json'")
    })
    const r = await handlers['app:set-scheduler'](trustedEvent(), { enabled: false })
    expect(r).toEqual({ ok: false, error: '保存调度设置失败' })
  })
})
