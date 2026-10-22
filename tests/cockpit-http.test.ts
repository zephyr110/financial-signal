import { describe, it, expect } from 'vitest'
import { fetchWithTimeout } from '../lib/cockpit/sources/http'

/**
 * 超时包装必须真正中止底层请求：否则数据源挂起时心跳会一直续租，
 * 唯一的 worker 被永久占死。
 */

function hangingFetch() {
  let seen: AbortSignal | null = null
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    seen = init?.signal || null
    seen?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })) as typeof fetch
  return { fetchImpl, signal: () => seen }
}

describe('fetchWithTimeout', () => {
  it('超时后中止请求并返回可读错误', async () => {
    const { fetchImpl, signal } = hangingFetch()
    await expect(fetchWithTimeout(fetchImpl, 20)('https://example.test'))
      .rejects.toThrow('请求超时（20ms）')
    expect(signal()?.aborted).toBe(true)
  })

  it('外部 signal 中止时原样传播，不误报为超时', async () => {
    const { fetchImpl } = hangingFetch()
    const outer = new AbortController()
    const pending = fetchWithTimeout(fetchImpl, 5_000)('https://example.test', { signal: outer.signal })
    outer.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('正常响应保留原有 init 并清理定时器', async () => {
    let received: RequestInit | undefined
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      received = init
      return new Response('ok')
    }) as typeof fetch
    const res = await fetchWithTimeout(fetchImpl, 1_000)('https://example.test', {
      method: 'POST',
      body: 'x',
    })
    expect(await res.text()).toBe('ok')
    expect(received?.method).toBe('POST')
    expect(received?.body).toBe('x')
    expect(received?.signal).toBeInstanceOf(AbortSignal)
  })
})
