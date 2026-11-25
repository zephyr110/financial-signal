import { describe, expect, it, vi } from 'vitest'
import {
  HttpError,
  createHttpClient,
  httpErrorMessage,
  type HttpRequestContext,
} from '../lib/http/client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchReturning(response: Response) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
}

describe('http client', () => {
  it('默认头、请求 id 与 JSON 序列化', async () => {
    const fetchMock = fetchReturning(jsonResponse({ data: { ok: true } }))
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const body = await client.post('/api/example', { answer: 42 })

    expect(body).toEqual({ data: { ok: true } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/example')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"answer":42}')
    const headers = init.headers as Headers
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{20,}$/i)
  })

  it('默认头可定制，单次请求头优先，requestId 可关闭', async () => {
    const fetchMock = fetchReturning(jsonResponse({}))
    const client = createHttpClient({
      fetchImpl: fetchMock as unknown as typeof fetch,
      headers: { 'X-Client': 'cockpit', Accept: 'application/vnd.fs+json' },
      requestId: false,
    })

    await client.get('/api/example', { headers: { 'X-Trace': 'trace-1' } })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('x-client')).toBe('cockpit')
    expect(headers.get('accept')).toBe('application/vnd.fs+json')
    expect(headers.get('x-trace')).toBe('trace-1')
    expect(headers.get('x-request-id')).toBeNull()
  })

  it('query 拼接跳过空值并保留片段', async () => {
    const fetchMock = fetchReturning(jsonResponse({}))
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await client.get('/api/example?fixed=1#detail', {
      query: { q: '中 文', page: 2, skip: null, tag: ['a', 'b'] },
    })

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/example?fixed=1&q=%E4%B8%AD%20%E6%96%87&page=2&tag=a&tag=b#detail',
    )
  })

  it('request 拦截器按注册顺序执行并可改写请求', async () => {
    const fetchMock = fetchReturning(jsonResponse({}))
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    const order: string[] = []

    const first = client.interceptors.request.use((context: HttpRequestContext) => {
      order.push('first')
      context.url = '/api/rewritten'
      context.headers.set('X-Step', 'first')
    })
    client.interceptors.request.use((context: HttpRequestContext) => {
      order.push('second')
      context.headers.set('X-Step2', 'second')
    })
    const removed = client.interceptors.request.use(() => {
      order.push('removed')
    })
    client.interceptors.request.eject(removed)

    await client.get('/api/example')

    expect(order).toEqual(['first', 'second'])
    expect(fetchMock.mock.calls[0][0]).toBe('/api/rewritten')
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get('x-step')).toBe('first')
    expect(headers.get('x-step2')).toBe('second')
  })

  it('response 拦截器可解包成功响应', async () => {
    const fetchMock = fetchReturning(jsonResponse({ data: { id: 7 }, meta: {} }))
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    client.interceptors.response.use((body) => {
      const envelope = body as { data?: unknown }
      return envelope && typeof envelope === 'object' && 'data' in envelope
        ? envelope.data ?? envelope
        : body
    })

    await expect(client.get('/api/example')).resolves.toEqual({ id: 7 })
  })

  it('HTTP 错误解析错误信封并保留字段校验详情', async () => {
    const payload = {
      error: {
        message: '参数不合法',
        code: 'VALIDATION',
        details: { issues: [{ message: 'code 必填' }, { message: '标题过长' }] },
        requestId: 'server-request-1',
      },
    }
    const fetchMock = fetchReturning(jsonResponse(payload, 422))
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const error = (await client.post('/api/example', {}).catch((err) => err)) as HttpError

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({
      status: 422,
      code: 'VALIDATION',
      requestId: 'server-request-1',
      details: { issues: [{ message: 'code 必填' }, { message: '标题过长' }] },
    })
    expect(error.message).toBe('参数不合法')
    expect(httpErrorMessage(error, '保存失败')).toBe('参数不合法：code 必填；标题过长')
  })

  it('兼容字符串错误体；无消息时用 fallbackMessage', async () => {
    const legacy = fetchReturning(jsonResponse({ error: '请先登录' }, 401))
    const legacyClient = createHttpClient({ fetchImpl: legacy as unknown as typeof fetch })
    const legacyError = (await legacyClient.get('/api/example').catch((err) => err)) as HttpError
    expect(legacyError).toBeInstanceOf(HttpError)
    expect(legacyError.status).toBe(401)
    expect(legacyError.message).toBe('请先登录')

    const empty = fetchReturning(jsonResponse({}, 500))
    const emptyClient = createHttpClient({ fetchImpl: empty as unknown as typeof fetch })
    const emptyError = (await emptyClient
      .post('/api/example', {}, { fallbackMessage: '保存失败，请重试' })
      .catch((err) => err)) as HttpError
    expect(emptyError.message).toBe('保存失败，请重试')
    expect(httpErrorMessage(emptyError, '网络错误')).toBe('保存失败，请重试')
  })

  it('response 错误拦截器可恢复请求，也可继续抛出', async () => {
    const fetchMock = fetchReturning(jsonResponse({ error: 'boom' }, 500))
    const recovering = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    recovering.interceptors.response.use(undefined, () => ({ recovered: true }))
    await expect(recovering.get('/api/example')).resolves.toEqual({ recovered: true })

    const throwing = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })
    throwing.interceptors.response.use(undefined, (error) => {
      throw error
    })
    await expect(throwing.get('/api/example')).rejects.toBeInstanceOf(HttpError)
  })

  it('调用方取消时保留 AbortError，且不再发请求', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const controller = new AbortController()
    const pending = client.get('/api/example', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(client.get('/api/example', { signal: alreadyAborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('超时转换为 HttpError TIMEOUT', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const error = (await client.get('/api/example', { timeoutMs: 10 }).catch((err) => err)) as HttpError

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'TIMEOUT', status: 0 })
    expect(error.message).toContain('10ms')
  })

  it('网络错误原样抛出（不包装成 HttpError）', async () => {
    const networkError = new TypeError('Failed to fetch')
    const fetchMock = vi.fn().mockRejectedValue(networkError)
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    await expect(client.get('/api/example')).rejects.toBe(networkError)
  })

  it('raw 返回原始响应，不解析、不因状态码抛错', async () => {
    const response = new Response('event: done\n\n', {
      status: 500,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const fetchMock = fetchReturning(response)
    const client = createHttpClient({ fetchImpl: fetchMock as unknown as typeof fetch })

    const raw = await client.raw('/api/agent', { method: 'POST', json: { stream: true } })

    expect(raw.status).toBe(500)
    expect(await raw.text()).toBe('event: done\n\n')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('accept')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-request-id')).toBeTruthy()
  })

  it('空响应与 parse:none 返回 null；漏标 JSON 的响应按内容兜底', async () => {
    const noContent = createHttpClient({
      fetchImpl: fetchReturning(new Response(null, { status: 204 })) as unknown as typeof fetch,
    })
    await expect(noContent.delete('/api/example')).resolves.toBeNull()

    const ignored = createHttpClient({
      fetchImpl: fetchReturning(new Response('ignored')) as unknown as typeof fetch,
    })
    await expect(ignored.post('/api/example', {}, { parse: 'none' })).resolves.toBeNull()

    const missingType = createHttpClient({
      fetchImpl: fetchReturning(new Response('{"ok":true}')) as unknown as typeof fetch,
    })
    await expect(missingType.get('/api/example')).resolves.toEqual({ ok: true })
  })
})
