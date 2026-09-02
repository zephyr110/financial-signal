import { getSessionUser, SESSION_COOKIE } from '../../../lib/auth';
import { getAuthDb } from '../../../lib/authDb';

/** GET /api/auth/me → { authenticated, username }（登录态校验）。
 * 桌面端 auth.db 尚无账号(首启)→ 200 { authenticated:false, setupRequired:true },
 * 登录页据此切「设置初始密码」流程(不返回 401,避免与"未登录"混淆)。 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  if (process.env.DESKTOP_MODE === '1') {
    const db = await getAuthDb();
    const cnt = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] });
    if (Number(cnt.rows[0].n) === 0) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ authenticated: false, setupRequired: true, desktop: true });
    }
  }
  const username = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
  res.setHeader('Cache-Control', 'no-store');
  if (!username) return res.status(401).json({ authenticated: false });
  res.status(200).json({ authenticated: true, username });
}
