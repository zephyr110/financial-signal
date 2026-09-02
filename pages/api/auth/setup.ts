import { setupAccount, sessionCookie } from '../../../lib/auth';

/** POST /api/auth/setup { username?, password } → 桌面首启初始化账号并直接登录。
 * 仅 DESKTOP_MODE 开放;Web 无账号由 ensureDefaultAccount 自动种子,不开放此端点。 */
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  if (process.env.DESKTOP_MODE !== '1') {
    return res.status(403).json({ error: '仅桌面端可初始化账号' });
  }
  const { username, password } = req.body || {};
  const result = await setupAccount(
    username != null ? String(username) : 'admin',
    password != null ? String(password) : '',
  );
  if (!result.ok) return res.status(400).json({ error: result.error || '初始化失败' });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', sessionCookie(result.token!));
  res.status(200).json({ ok: true });
}
