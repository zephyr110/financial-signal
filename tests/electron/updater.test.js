import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import Module from 'node:module'

// updater.js 是 CJS,内部 require('electron-updater') 与 require('electron')
// 走 node 原生 require,vi.mock 拦不到 —— 与 ipc.test.js 同一 Module._load 手法,
// 在动态 import 之前把两个模块都换成桩。
class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.autoDownload = null
    this.checkCalls = 0
    this.downloadCalls = 0
    this.quitAndInstallCalls = 0
    this.checkImpl = null
  }
  checkForUpdates() {
    this.checkCalls++
    if (this.checkImpl) return this.checkImpl()
    return Promise.resolve({ updateInfo: { version: '9.9.9' } })
  }
  downloadUpdate() {
    this.downloadCalls++
    return Promise.resolve()
  }
  quitAndInstall() {
    this.quitAndInstallCalls++
  }
}

const updater = new FakeUpdater()
const electronStub = { dialog: { showMessageBox: vi.fn() } }

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron-updater') return { autoUpdater: updater }
  if (request === 'electron') return electronStub
  return origLoad.apply(this, arguments)
}

/** checkedOnce 是模块级状态,每次重载拿到全新的 updater.js。 */
async function loadInitUpdater() {
  vi.resetModules()
  return (await import('../../electron/updater')).initUpdater
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  updater.removeAllListeners()
  updater.checkCalls = 0
  updater.downloadCalls = 0
  updater.quitAndInstallCalls = 0
  updater.checkImpl = null
  electronStub.dialog.showMessageBox.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('checkedOnce 语义(启动静默只查一次,手动不受限)', () => {
  it('第一次静默 initUpdater() 触发一次 checkForUpdates,第二次不再触发', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater()
    initUpdater()
    expect(updater.checkCalls).toBe(1)
  })

  it('手动检查不受 checkedOnce 限制,每次都触发', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater()
    initUpdater({ manual: true })
    initUpdater({ manual: true })
    expect(updater.checkCalls).toBe(3)
  })

  it('checkForUpdates 拒绝时被 catch,不抛异常', async () => {
    const initUpdater = await loadInitUpdater()
    updater.checkImpl = () => Promise.reject(new Error('net down'))
    expect(() => initUpdater()).not.toThrow()
    expect(() => initUpdater({ manual: true })).not.toThrow()
    await flush()
    expect(updater.checkCalls).toBe(2)
  })
})

describe('update-available 处理', () => {
  it('静默:不弹窗,直接下载', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater()
    updater.emit('update-available', { version: '3.0.0' })
    await flush()
    expect(electronStub.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(updater.downloadCalls).toBe(1)
  })

  it('手动:点"下载"(response 0)→ 下载', async () => {
    const initUpdater = await loadInitUpdater()
    electronStub.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    initUpdater({ manual: true })
    updater.emit('update-available', { version: '3.0.0' })
    await flush()
    expect(electronStub.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: '发现新版本 3.0.0' }),
    )
    expect(updater.downloadCalls).toBe(1)
  })

  it('手动:点"稍后"(response 1)→ 不下载', async () => {
    const initUpdater = await loadInitUpdater()
    electronStub.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    initUpdater({ manual: true })
    updater.emit('update-available', { version: '3.0.0' })
    await flush()
    expect(updater.downloadCalls).toBe(0)
  })

  it('initUpdater 多次调用不重复注册监听器(同一事件只触发一次)', async () => {
    // 启动静默 + 托盘手动都会调 initUpdater;若监听器重复注册,
    // update-available 会触发两遍:静默副本直接下载、手动副本弹窗后下载
    const initUpdater = await loadInitUpdater()
    electronStub.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    initUpdater()
    initUpdater({ manual: true })
    updater.emit('update-available', { version: '3.0.0' })
    await flush()
    expect(electronStub.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(updater.downloadCalls).toBe(1)
  })
})

describe('update-downloaded 处理', () => {
  it('点"立即重启"(response 0)→ quitAndInstall', async () => {
    const initUpdater = await loadInitUpdater()
    electronStub.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    initUpdater()
    updater.emit('update-downloaded', { version: '3.0.0' })
    await flush()
    expect(electronStub.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: '新版本 3.0.0 已下载,重启后生效' }),
    )
    expect(updater.quitAndInstallCalls).toBe(1)
  })

  it('点"稍后"(response 1)→ 不重启', async () => {
    const initUpdater = await loadInitUpdater()
    electronStub.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    initUpdater()
    updater.emit('update-downloaded', { version: '3.0.0' })
    await flush()
    expect(updater.quitAndInstallCalls).toBe(0)
  })
})

describe('update-not-available / error 处理', () => {
  it('手动:已是最新版本弹 info 框;静默:不弹', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater()
    updater.emit('update-not-available')
    await flush()
    expect(electronStub.dialog.showMessageBox).not.toHaveBeenCalled()

    initUpdater({ manual: true })
    updater.emit('update-not-available')
    await flush()
    expect(electronStub.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', message: '已是最新版本' }),
    )
  })

  it('手动:error 弹"检查更新失败";静默:吞掉只记日志', async () => {
    const initUpdater = await loadInitUpdater()
    initUpdater()
    updater.emit('error', new Error('404 not found'))
    await flush()
    expect(electronStub.dialog.showMessageBox).not.toHaveBeenCalled()

    initUpdater({ manual: true })
    updater.emit('error', new Error('404 not found'))
    await flush()
    expect(electronStub.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: '检查更新失败: 404 not found' }),
    )
  })
})
