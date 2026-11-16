import { SESSION_COOKIE, getSessionIdentity } from './auth'

/**
 * 从请求 cookie 解析当前账号 id，供数据归属查询使用。
 * 鉴权在 proxy.ts（未登录的 /api/* 直接 401）；这里只回答“是谁”。
 * 取不到会话时返回 null，调用方沿用 legacy 全局行为。
 */
export async function requestUserId(req: {
  cookies?: Partial<Record<string, string | undefined>>
}): Promise<number | null> {
  try {
    const token = req.cookies?.[SESSION_COOKIE]
    return (await getSessionIdentity(token))?.userId ?? null
  } catch {
    return null
  }
}
