export async function deskApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message = json?.error?.message || json?.error || `请求失败（${res.status}）`
    throw new Error(String(message))
  }
  return (json?.data ?? json) as T
}
