import { describe, expect, it } from 'vitest'
import { acquireAgentSessionLock, AgentSessionBusyError } from './lock'

describe('agent session lock', () => {
  it('同一会话并发时第二次立即失败，释放后可重新获取', async () => {
    const release = await acquireAgentSessionLock(42)
    await expect(acquireAgentSessionLock(42)).rejects.toBeInstanceOf(AgentSessionBusyError)
    release()
    const again = await acquireAgentSessionLock(42)
    again()
  })

  it('不同会话互不影响', async () => {
    const a = await acquireAgentSessionLock(1)
    const b = await acquireAgentSessionLock(2)
    a()
    b()
  })
})
