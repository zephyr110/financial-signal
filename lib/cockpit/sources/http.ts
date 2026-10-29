export type FetchLike = typeof fetch

const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 给数据源请求加超时：对端挂起时让任务失败重试，而不是靠心跳永久续租。
 * 保留调用方已有 signal，任一触发都会中止请求。
 */
export function fetchWithTimeout(fetchImpl: FetchLike, timeoutMs = DEFAULT_TIMEOUT_MS): FetchLike {
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const options = init || {}
    const controller = new AbortController()
    const outer = options.signal
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortFromOuter = () => controller.abort()
    if (outer) {
      if (outer.aborted) abortFromOuter()
      else outer.addEventListener('abort', abortFromOuter, { once: true })
    }
    try {
      return await fetchImpl(input, { ...options, signal: controller.signal })
    } catch (err) {
      if (timedOut) throw new Error(`请求超时（${timeoutMs}ms）`)
      throw err
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', abortFromOuter)
    }
  }) as FetchLike
}
