import { getSessionUser, SESSION_COOKIE } from '../../../lib/auth';

/** GET /api/auth/me → { authenticated, username }（登录态校验）。 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  // 桌面端:本地单用户应用,与 proxy.ts 门卫一致地放行(否则 app-shell 首启会跳登录页)
  if (process.env.DESKTOP_MODE === '1') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ authenticated: true, username: 'desktop' });
  }
  const username = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
  res.setHeader('Cache-Control', 'no-store');
  if (!username) return res.status(401).json({ authenticated: false });
  res.status(200).json({ authenticated: true, username });
}
