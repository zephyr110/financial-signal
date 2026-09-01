import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServerManager } from '../../electron/server'

/**
 * server 生命周期回归测试(防回归 e40dc59 修的 4 个缺陷 + 本轮必改项):
 *  - 崩溃 → 退避重启(onCrash 收到新 URL)
 *  - restarts 连续失败语义:健康后重置,退避 delay 回到 2s
 *  - 5 次连续崩溃 → onGiveUp
 *  - stop 取消 pending restart、SIGKILL 兜底
 *  - 启动期崩溃 → start() reject
 *  - spawn 'error' → 与 'exit' 统一走重启路径
 * 全部依赖注入(fake spawn/fake child/fake waitForHealthy/fake timers),不碰真实进程。
 */

/** 模拟 child_process.spawn 返回的 ChildProcess:on 捕获监听器,emit 手动触发。 */
function makeFakeChild() {
  const listeners = {}
  const child = {
    exitCode: null, // kill 后进程"不退出"(忽略 SIGTERM),与真实信号语义一致
    killed: false,
    kill: vi.fn((sig) => { child.killed = true; return true }),
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    on(event, fn) {
      ;(listeners[event] ||= []).push(fn)
      return child
    },
    emit(event, ...args) {
      for (const fn of [...(listeners[event] || [])]) fn(...args)
    },
  }
  return child
}

/** 组装一个全部依赖可注入的 manager,返回句柄供断言。spawn 可注入自定义实现(如异步补发 exit 的 fake child)。 */
function setup({ waitForHealthy, onCrash, onGiveUp, spawn: spawnImpl } = {}) {
  const children = []
  const spawn = spawnImpl || vi.fn(() => {
    const c = makeFakeChild()
    children.push(c)
    return c
  })
  const crashSpy = onCrash || vi.fn()
  const giveUpSpy = onGiveUp || vi.fn()
  const log = vi.fn()
  const errorLog = vi.fn()
  let port = 3000
  const manager = createServerManager({
    spawn,
    dbPath: '/tmp/test.db',
    findFreePort: async () => { port += 1; return port },
    waitForHealthy: waitForHealthy || (async () => true),
    onCrash: crashSpy,
    onGiveUp: giveUpSpy,
    log,
    errorLog,
  })
  return { manager, spawn, children, onCrash: crashSpy, onGiveUp: giveUpSpy, log, errorLog }
}

describe('createServerManager', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start() spawns the standalone server and returns the base URL', async () => {
    const { manager, spawn, children } = setup()
    const url = await manager.start()
    expect(url).toBe('http://127.0.0.1:3001')
    expect(spawn).toHaveBeenCalledTimes(1)
    // ELECTRON_RUN_AS_NODE 模式:可执行文件必须是当前进程的 execPath(不依赖系统 node)
    expect(spawn).toHaveBeenCalledWith(process.execPath, expect.any(Array), expect.objectContaining({
      cwd: expect.stringContaining('.next/standalone'),
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    }))
    expect(children[0].stdout.on).toHaveBeenCalledWith('data', expect.any(Function))
    expect(manager.getUrl()).toBe(url)
  })

  it('restarts with backoff after a crash and notifies onCrash with the new URL', async () => {
    const { manager, spawn, children, onCrash, log } = setup()
    const url1 = await manager.start()

    children[0].emit('exit', 1, null)
    expect(spawn).toHaveBeenCalledTimes(1) // 未到退避时间,尚未重启
    await vi.advanceTimersByTimeAsync(2000) // BASE_RETRY_MS * 2^1
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(onCrash).toHaveBeenCalledWith('http://127.0.0.1:3002')
    expect(manager.getUrl()).toBe('http://127.0.0.1:3002')
    expect(log).toHaveBeenCalledWith('[server] exited(1), restart in 2000ms (1/5)')
    expect(url1).toBe('http://127.0.0.1:3001')
  })

  it('resets the restart counter after a successful healthy check', async () => {
    const { manager, children, log } = setup()
    await manager.start() // 健康 → restarts = 0
    children[0].emit('exit', 1, null) // 第 1 次崩溃
    await vi.advanceTimersByTimeAsync(2000) // 重启成功(健康) → restarts 重置
    children[1].emit('exit', 1, null) // 再次崩溃:连续失败只累计 1 次
    expect(log).toHaveBeenLastCalledWith('[server] exited(1), restart in 2000ms (1/5)')
  })

  it('gives up after 5 consecutive crashes and calls onGiveUp', async () => {
    // 连续失败:每次重启也都撑不过健康检查(waitForHealthy 永不 resolve)
    const { manager, spawn, children, onGiveUp, errorLog } = setup({
      waitForHealthy: () => new Promise(() => {}),
    })
    const p = manager.start()
    await vi.advanceTimersByTimeAsync(0)
    const delays = [2000, 4000, 8000, 16000, 30000]
    for (let i = 0; i < 5; i++) {
      children[i].emit('exit', 1, null) // 崩溃 → restarts += 1
      if (i === 0) {
        await expect(p).rejects.toThrow('standalone server exited before becoming healthy')
      }
      await vi.advanceTimersByTimeAsync(delays[i]) // 重启 spawn 下一个 child
    }
    expect(spawn).toHaveBeenCalledTimes(6) // 初始 + 5 次重启
    children[5].emit('exit', 1, null) // 第 6 次崩溃:restarts=5 已达上限
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalledWith('[server] too many crashes, giving up')
    expect(spawn).toHaveBeenCalledTimes(6) // 放弃后不再 spawn
  })

  it('stop() cancels a pending restart', async () => {
    const { manager, spawn, children } = setup()
    await manager.start()
    children[0].emit('exit', 1, null) // 崩溃 → 已调度重启
    manager.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(spawn).toHaveBeenCalledTimes(1) // 不再 spawn
  })

  it('stop() escalates to SIGKILL if the child ignores SIGTERM', async () => {
    const { manager, children } = setup()
    await manager.start()
    const c = children[0]
    manager.stop()
    expect(c.kill).toHaveBeenCalledWith('SIGTERM')
    expect(manager.getUrl()).toBeNull()
    await vi.advanceTimersByTimeAsync(500) // 进程仍未退出(exitCode 为 null)→ 兜底
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('rejects when the child exits before becoming healthy', async () => {
    const { manager, children } = setup({ waitForHealthy: () => new Promise(() => {}) })
    const p = manager.start()
    await vi.advanceTimersByTimeAsync(0) // 让 findFreePort 的微任务完成,child 已 spawn
    children[0].emit('exit', 1, null)
    await expect(p).rejects.toThrow('standalone server exited before becoming healthy')
  })

  it('treats spawn errors like crashes: rejects start() and schedules a restart', async () => {
    // waitForHealthy 永不 resolve,避免竞态让 start() 先以 healthy 结束
    const { manager, spawn, children, onGiveUp, log, errorLog } = setup({
      waitForHealthy: () => new Promise(() => {}),
    })
    const p = manager.start()
    await vi.advanceTimersByTimeAsync(0)
    children[0].emit('error', new Error('spawn ENOENT'))
    await expect(p).rejects.toThrow('standalone server spawn failed: spawn ENOENT')
    expect(errorLog).toHaveBeenCalledWith('[server] spawn error:', 'spawn ENOENT')
    expect(log).toHaveBeenCalledWith('[server] exited(null sig=spawn-error), restart in 2000ms (1/5)')
    await vi.advanceTimersByTimeAsync(2000) // 走重启路径
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('deduplicates restart scheduling when error+exit both fire (restartTimer 守卫)', async () => {
    const { manager, spawn, children } = setup({ waitForHealthy: () => new Promise(() => {}) })
    const p = manager.start()
    await vi.advanceTimersByTimeAsync(0)
    // 同一实例先 'error' 后 'exit'(spawn 失败的典型事件序)
    children[0].emit('error', new Error('spawn ENOENT'))
    children[0].emit('exit', 1, null)
    await expect(p).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(2000)
    // 只重启一次(去重),restarts 只累计 1
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]).toBeTruthy()
  })

  it('can start again after stop (idempotent lifecycle)', async () => {
    const { manager, spawn } = setup()
    expect(manager.getUrl()).toBeNull()
    const url1 = await manager.start()
    manager.stop()
    expect(manager.getUrl()).toBeNull()
    const url2 = await manager.start()
    expect(url2).toBe('http://127.0.0.1:3002')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(manager.getUrl()).toBe(url2)
    manager.stop()
  })

  it('ignores the killed child delayed exit after stop→start (no ghost restart or orphan)', async () => {
    // 真实进程被 SIGTERM 后 'exit' 在下一事件循环才送达:stop() 后立即 start()
    // (restartAfterDbChange 场景)会让旧 child 的 exit 落在新生命周期里。无代际守卫时
    // 旧 exit 被当作崩溃 → 清掉新进程引用 + 2s 后 spawn 第三个 server(幽灵重启),
    // 健康工作的第二个 server 脱管成孤儿进程。
    const spawnedChildren = []
    const spawnImpl = vi.fn(() => {
      const c = makeFakeChild()
      c.kill = vi.fn(() => {
        setTimeout(() => { c.exitCode = 0; c.emit('exit', null, 'SIGTERM') }, 0)
        return true
      })
      spawnedChildren.push(c)
      return c
    })
    const { manager, spawn, onCrash, log } = setup({ spawn: spawnImpl })

    await manager.start() // 第一个 server 健康
    expect(spawn).toHaveBeenCalledTimes(1)

    manager.stop() // SIGTERM,真实 exit 异步送达
    const url2 = await manager.start() // 立即再 start(与 restartAfterDbChange 一致)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(url2).toBe('http://127.0.0.1:3002')

    await vi.advanceTimersByTimeAsync(0) // 旧 child 的 exit 送达
    await vi.advanceTimersByTimeAsync(2000) // 旧代码的幽灵重启窗口(退避 2000ms)
    expect(spawn).toHaveBeenCalledTimes(2) // 未被当成崩溃 → 无第三个 server
    expect(onCrash).not.toHaveBeenCalled()
    expect(manager.getUrl()).toBe(url2) // 第二个 server 仍是当前 server
    expect(spawnedChildren[1].kill).not.toHaveBeenCalled() // 新 child 未被误杀

    // restarts 未被旧 exit 污染:当前 child 崩溃仍从 2000ms(1/5)退避开始
    spawnedChildren[1].emit('exit', 1, null)
    expect(log).toHaveBeenLastCalledWith('[server] exited(1), restart in 2000ms (1/5)')
  })
})
