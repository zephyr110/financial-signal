import { getSetting, SETTING_KEYS } from './settings';

/**
 * Protect cron/admin endpoints with CRON_SECRET.
 * Accepts ?token= or Authorization: Bearer (Vercel Cron sends the latter).
 * Secret resolution order: 设置弹窗（app_settings 表，30s 缓存）→ 环境变量 CRON_SECRET。
 * In production/Vercel, a secret must be configured somewhere.
 */
export async function assertCronAuth(req, res) {
  // 桌面端本地调度:主进程调用自身服务,无需 secret
  if (process.env.DESKTOP_MODE === '1') return true;
  let cronSecret;
  try {
    cronSecret = (await getSetting(SETTING_KEYS.CRON_SECRET)) || process.env.CRON_SECRET;
  } catch {
    // settings 表不可用（未迁移/DB 异常）时降级为环境变量
    cronSecret = process.env.CRON_SECRET;
  }

  if (!cronSecret) {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      res.status(503).json({ error: 'CRON_SECRET not configured' });
      return false;
    }
    return true; // local dev without secret
  }

  const bearer = req.headers.authorization;
  const tokenOk =
    req.query.token === cronSecret ||
    bearer === `Bearer ${cronSecret}`;

  if (!tokenOk) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
