import { createHttpClient, type HttpRequestConfig } from '@/lib/http/client'

// desk 接口统一返回 { data, meta }：用响应拦截器解包，调用方仍拿业务对象。
const deskHttp = createHttpClient()
deskHttp.interceptors.response.use((body) => {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data ?? body
  }
  return body
})

export async function deskApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const config: HttpRequestConfig = {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    cache: init.cache,
    credentials: init.credentials,
    keepalive: init.keepalive,
    fallbackMessage: '请求失败，请稍后重试',
  }
  // 现有调用方传 JSON 字符串；交给客户端序列化并自动补 Content-Type。
  if (typeof init.body === 'string') {
    try {
      config.json = JSON.parse(init.body)
      config.body = null
    } catch {
      // 非 JSON body 保持原样
    }
  }
  return deskHttp.request<T>(url, config)
}
