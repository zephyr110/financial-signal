/**
 * 同源 /api 请求的统一客户端：默认头、JSON 序列化、超时/中断、错误信封解析，
 * 以及 axios 风格的 request/response 拦截器。
 *
 * SSE 等流式响应走 raw()：返回原始 Response，不解析、不按状态码抛错。
 */

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | QueryValue[]>
export type HttpParseMode = 'auto' | 'json' | 'text' | 'none'

export interface HttpRequestConfig {
  method?: string
  headers?: HeadersInit
  query?: QueryParams
  json?: unknown
  body?: BodyInit | null
  signal?: AbortSignal | null
  /** 0 或负数表示不设超时（默认） */
  timeoutMs?: number
  cache?: RequestCache
  credentials?: RequestCredentials
  keepalive?: boolean
  parse?: HttpParseMode
  /** 服务端没给错误消息时展示的文案 */
  fallbackMessage?: string
  /** 默认生成 X-Request-Id；传 false 关闭，传字符串可固定 */
  requestId?: boolean | string
}

export interface HttpRequestContext {
  url: string
  method: string
  headers: Headers
  body: BodyInit | null
  config: HttpRequestConfig
  requestId: string | null
}

export interface HttpResponseContext {
  request: HttpRequestContext
  response: Response
}

export type RequestInterceptor = (context: HttpRequestContext) => void | Promise<void>
export type ResponseFulfilled = (data: unknown, context: HttpResponseContext) => unknown | Promise<unknown>
export type ResponseRejected = (error: unknown, context: HttpResponseContext | null) => unknown | Promise<unknown>

export interface RequestInterceptorManager {
  use(interceptor: RequestInterceptor): number
  eject(id: number): void
  clear(): void
}

export interface ResponseInterceptorManager {
  use(onFulfilled?: ResponseFulfilled, onRejected?: ResponseRejected): number
  eject(id: number): void
  clear(): void
}

export interface HttpClientOptions {
  baseUrl?: string
  headers?: HeadersInit
  /** 默认 0：不设超时。本地长任务（如 /api/desk/investigations）可达 90s */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 默认 true */
  requestId?: boolean
}

export interface HttpClient {
  readonly interceptors: {
    request: RequestInterceptorManager
    response: ResponseInterceptorManager
  }
  request<T = unknown>(url: string, config?: HttpRequestConfig): Promise<T>
  get<T = unknown>(url: string, config?: HttpRequestConfig): Promise<T>
  post<T = unknown>(url: string, json?: unknown, config?: HttpRequestConfig): Promise<T>
  put<T = unknown>(url: string, json?: unknown, config?: HttpRequestConfig): Promise<T>
  patch<T = unknown>(url: string, json?: unknown, config?: HttpRequestConfig): Promise<T>
  delete<T = unknown>(url: string, config?: HttpRequestConfig): Promise<T>
  /** 原始响应：只套请求拦截器与默认头，不做状态码校验、不解析 body */
  raw(url: string, config?: HttpRequestConfig): Promise<Response>
}

interface ErrorEnvelope {
  message?: string
  code?: string
  requestId?: string
  details?: unknown
}

export class HttpError extends Error {
  readonly status: number
  readonly code?: string
  readonly requestId?: string
  readonly details?: unknown
  readonly body: unknown
  readonly url: string
  readonly method: string

  constructor(init: {
    message: string
    status: number
    url: string
    method: string
    code?: string
    requestId?: string
    details?: unknown
    body?: unknown
  }) {
    super(init.message)
    this.name = 'HttpError'
    this.status = init.status
    this.url = init.url
    this.method = init.method
    this.code = init.code
    this.requestId = init.requestId
    this.details = init.details
    this.body = init.body
    // 部分运行环境沿用旧 Error 原型链，确保 instanceof 可用
    Object.setPrototypeOf(this, HttpError.prototype)
  }
}

/** HttpError 用服务端消息（含字段校验 issues），其余错误用 fallback。 */
export function httpErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof HttpError)) return fallback
  const base = error.message?.trim() || fallback
  const issues = issueMessages(error.details)
  return issues.length > 0 ? `${base}：${issues.join('；')}` : base
}

class InterceptorStore<T> {
  private readonly handlers = new Map<number, T>()
  private sequence = 0

  use(handler: T): number {
    const id = ++this.sequence
    this.handlers.set(id, handler)
    return id
  }

  eject(id: number): void {
    this.handlers.delete(id)
  }

  clear(): void {
    this.handlers.clear()
  }

  list(): T[] {
    return [...this.handlers.values()]
  }
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const baseUrl = options.baseUrl || ''
  const defaultTimeoutMs = options.timeoutMs ?? 0
  const generateRequestId = options.requestId !== false
  const requestInterceptors = new InterceptorStore<RequestInterceptor>()
  const responseInterceptors = new InterceptorStore<{
    onFulfilled?: ResponseFulfilled
    onRejected?: ResponseRejected
  }>()
  const fetchImpl: typeof fetch =
    options.fetchImpl || ((input, init) => globalThis.fetch(input, init))

  async function prepare(
    url: string,
    config: HttpRequestConfig,
    { jsonAccept }: { jsonAccept: boolean },
  ): Promise<HttpRequestContext> {
    const headers = new Headers(options.headers)
    new Headers(config.headers || {}).forEach((value, key) => headers.set(key, value))

    let requestId: string | null = null
    const requestIdOption = config.requestId ?? generateRequestId
    if (requestIdOption !== false) {
      requestId =
        (typeof requestIdOption === 'string' ? requestIdOption : null) ||
        headers.get('x-request-id') ||
        createRequestId()
      headers.set('X-Request-Id', requestId)
    }

    if (jsonAccept && !headers.has('Accept')) headers.set('Accept', 'application/json')

    let body: BodyInit | null = config.body ?? null
    if (config.json !== undefined) {
      if (body !== null) throw new TypeError('json 与 body 不能同时使用')
      body = JSON.stringify(config.json)
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    }

    const context: HttpRequestContext = {
      url: appendQuery(joinUrl(baseUrl, url), config.query),
      method: (config.method || 'GET').toUpperCase(),
      headers,
      body,
      config,
      requestId,
    }
    for (const interceptor of requestInterceptors.list()) await interceptor(context)
    return context
  }

  async function dispatch(context: HttpRequestContext): Promise<Response> {
    const caller = context.config.signal || null
    if (caller?.aborted) throw abortReason(caller)

    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort(caller?.reason)
    caller?.addEventListener('abort', onAbort, { once: true })
    const timeoutMs = context.config.timeoutMs ?? defaultTimeoutMs
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, timeoutMs)
        : null

    try {
      return await fetchImpl(context.url, {
        method: context.method,
        headers: context.headers,
        body: context.body,
        signal: controller.signal,
        ...(context.config.cache ? { cache: context.config.cache } : {}),
        ...(context.config.credentials ? { credentials: context.config.credentials } : {}),
        ...(context.config.keepalive ? { keepalive: true } : {}),
      })
    } catch (error) {
      if (timedOut) {
        throw new HttpError({
          message: `请求超时（${timeoutMs}ms）`,
          status: 0,
          code: 'TIMEOUT',
          url: context.url,
          method: context.method,
          requestId: context.requestId || undefined,
        })
      }
      // 调用方主动取消：保持原生 AbortError 语义，便于调用处统一识别
      if (caller?.aborted) throw abortReason(caller)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      caller?.removeEventListener('abort', onAbort)
    }
  }

  async function request<T>(url: string, config: HttpRequestConfig = {}): Promise<T> {
    let context: HttpRequestContext | null = null
    let response: Response | null = null
    let ok = true
    let data: unknown = null
    let failure: unknown = null

    try {
      context = await prepare(url, config, { jsonAccept: true })
      response = await dispatch(context)
      if (!response.ok) throw await buildHttpError(context, response, config.fallbackMessage)
      data = await parseBody(response, config.parse || 'auto', context, config.fallbackMessage)
    } catch (error) {
      ok = false
      failure = error
    }

    const responseContext = context && response ? { request: context, response } : null
    for (const interceptor of responseInterceptors.list()) {
      if (ok) {
        if (!interceptor.onFulfilled) continue
        try {
          data = await interceptor.onFulfilled(data, responseContext as HttpResponseContext)
        } catch (error) {
          ok = false
          failure = error
        }
      } else if (interceptor.onRejected) {
        try {
          data = await interceptor.onRejected(failure, responseContext)
          ok = true
          failure = null
        } catch (error) {
          ok = false
          failure = error
        }
      }
    }

    if (!ok) throw failure
    return data as T
  }

  return {
    interceptors: {
      request: {
        use: (interceptor) => requestInterceptors.use(interceptor),
        eject: (id) => requestInterceptors.eject(id),
        clear: () => requestInterceptors.clear(),
      },
      response: {
        use: (onFulfilled, onRejected) => responseInterceptors.use({ onFulfilled, onRejected }),
        eject: (id) => responseInterceptors.eject(id),
        clear: () => responseInterceptors.clear(),
      },
    },
    request,
    get: (url, config) => request(url, { ...config, method: 'GET' }),
    post: (url, json, config) => request(url, { ...config, method: 'POST', json }),
    put: (url, json, config) => request(url, { ...config, method: 'PUT', json }),
    patch: (url, json, config) => request(url, { ...config, method: 'PATCH', json }),
    delete: (url, config) => request(url, { ...config, method: 'DELETE' }),
    raw: async (url, config = {}) => dispatch(await prepare(url, config, { jsonAccept: false })),
  }
}

/** 应用内默认客户端；需要全局拦截器时 createHttpClient() 后自行注册。 */
export const http = createHttpClient()

async function buildHttpError(
  context: HttpRequestContext,
  response: Response,
  fallbackMessage?: string,
): Promise<HttpError> {
  const text = await response.text().catch(() => '')
  const body = parseErrorBody(text, response.headers.get('content-type') || '')
  const info = extractErrorInfo(body)
  return new HttpError({
    status: response.status,
    message: info.message || fallbackMessage || `请求失败（${response.status}）`,
    code: info.code,
    requestId:
      info.requestId ||
      response.headers.get('x-request-id') ||
      context.requestId ||
      undefined,
    details: info.details,
    body,
    url: context.url,
    method: context.method,
  })
}

async function parseBody(
  response: Response,
  parse: HttpParseMode,
  context: HttpRequestContext,
  fallbackMessage?: string,
): Promise<unknown> {
  if (parse === 'none') return null
  if (response.status === 204 || response.status === 205) return null

  const contentType = response.headers.get('content-type') || ''
  if (parse === 'json' || (parse === 'auto' && isJsonType(contentType))) {
    const text = await response.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw invalidJsonError(context, response, text, fallbackMessage)
    }
  }
  if (parse === 'text') return response.text()

  const text = await response.text()
  if (!text) return null
  // 服务端漏了 JSON content-type 时按内容兜底，避免调用方拿到字符串
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      // 普通文本以 { 开头也可以，落回原文
    }
  }
  return text
}

function invalidJsonError(
  context: HttpRequestContext,
  response: Response,
  text: string,
  fallbackMessage?: string,
): HttpError {
  return new HttpError({
    status: response.status,
    code: 'INVALID_JSON',
    message: fallbackMessage || '响应格式异常',
    requestId: response.headers.get('x-request-id') || context.requestId || undefined,
    body: text,
    url: context.url,
    method: context.method,
  })
}

function parseErrorBody(text: string, contentType: string): unknown {
  if (!text) return null
  if (isJsonType(contentType)) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractErrorInfo(body: unknown): ErrorEnvelope {
  const info: ErrorEnvelope = {}
  if (isRecord(body)) {
    const error = body.error
    if (isRecord(error)) {
      if (typeof error.message === 'string' && error.message.trim()) info.message = error.message
      if (typeof error.code === 'string') info.code = error.code
      if (typeof error.requestId === 'string') info.requestId = error.requestId
      info.details = error.details
    } else if (typeof error === 'string' && error.trim()) {
      info.message = error
    } else if (typeof body.message === 'string' && body.message.trim()) {
      info.message = body.message
    }
  } else if (
    typeof body === 'string' &&
    body.trim() &&
    body.length <= 300 &&
    !body.trim().startsWith('<')
  ) {
    // 纯文本错误（网关/代理）也保留，过长的 HTML 不塞进提示
    info.message = body.trim()
  }
  return info
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isJsonType(contentType: string): boolean {
  return /\bjson\b/i.test(contentType)
}

function issueMessages(details: unknown): string[] {
  if (!isRecord(details) || !Array.isArray(details.issues)) return []
  return details.issues
    .map((issue) => (isRecord(issue) && typeof issue.message === 'string' ? issue.message.trim() : ''))
    .filter(Boolean)
}

function createRequestId(): string {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function joinUrl(baseUrl: string, url: string): string {
  if (!baseUrl || /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
  return `${baseUrl.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
}

function appendQuery(url: string, query?: QueryParams): string {
  if (!query) return url
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (item === undefined || item === null) continue
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`)
    }
  }
  if (parts.length === 0) return url
  const hashIndex = url.indexOf('#')
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  return `${base}${base.includes('?') ? '&' : '?'}${parts.join('&')}${hash}`
}
