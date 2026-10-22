import crypto from 'crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import { getSourceHealth } from './repo'
import type { ApiMeta } from './types'

export function requestId(req: NextApiRequest): string {
  const header = req.headers['x-request-id']
  if (typeof header === 'string' && header.length <= 80) return header
  return crypto.randomUUID()
}

export function noStore(res: NextApiResponse): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0')
}

export function sendData<T>(res: NextApiResponse, data: T, meta?: Partial<ApiMeta>): void {
  noStore(res)
  res.status(200).json({
    data,
    meta: {
      asOf: meta?.asOf || new Date().toISOString(),
      sourceHealth: meta?.sourceHealth || [],
    },
  })
}

export function sendError(
  req: NextApiRequest,
  res: NextApiResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  noStore(res)
  res.status(status).json({
    error: {
      code,
      message,
      details: details ?? null,
      requestId: requestId(req),
    },
  })
}

export function ensureMethod(req: NextApiRequest, res: NextApiResponse, allowed: string[]): boolean {
  if (allowed.includes(req.method || '')) return true
  res.setHeader('Allow', allowed.join(', '))
  sendError(req, res, 405, 'METHOD_NOT_ALLOWED', '请求方法不支持')
  return false
}

/** 浏览器跨站写请求直接拒绝；没有 Origin 的本地脚本仍由登录会话保护。 */
export function ensureSameOrigin(req: NextApiRequest): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export async function buildMeta(asOf?: string): Promise<ApiMeta> {
  let sourceHealth: ApiMeta['sourceHealth'] = []
  try {
    sourceHealth = await getSourceHealth()
  } catch {
    sourceHealth = []
  }
  return { asOf: asOf || new Date().toISOString(), sourceHealth }
}

export function queryString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
