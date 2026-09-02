import { getSessionUser, SESSION_COOKIE } from '../../../lib/auth';

/** GET /api/auth/me → { authenticated, username }（登录态校验）。 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  const username = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
  res.setHeader('Cache-Control', 'no-store');
  if (!username) return res.status(401).json({ authenticated: false });
  res.status(200).json({ authenticated: true, username });
}
