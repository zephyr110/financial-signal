import { SESSION_COOKIE, getSessionIdentity } from './auth'

/**
 * 从请求 cookie 解析当前账号 id。
 * 无会话（桌面本地/未登录）返回 null，调用方沿用 legacy 全局行为。
 * 注意：这是数据归属，不是安全边界——Agent API 本身无 middleware 鉴权。
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
