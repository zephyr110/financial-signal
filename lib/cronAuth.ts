import { getSetting, SETTING_KEYS } from './settings';

/**
 * 本机 Origin 判定(桌面端专用):Origin 必须为 127.0.0.1/localhost 的 http(s),
 * 且端口必须与本请求的 Host 一致——仅靠"localhost 任意端口"会让同机其他本地
 * 服务(不同端口)跨源打穿 cron/设置/agent 端点(消耗用户 LLM 额度)。
 * host 形如 "127.0.0.1:3010"(或带默认端口的 "localhost")。
 */
export function isLocalOrigin(origin: unknown, host?: unknown): boolean {
  if (typeof origin !== 'string') return false;
  try {
    const o = new URL(origin);
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    if (o.hostname !== '127.0.0.1' && o.hostname !== 'localhost') return false;
    const h = String(host || '');
    const hostPort = h.includes(':') ? h.slice(h.lastIndexOf(':') + 1) : '80';
    return o.port === hostPort;
  } catch {
    return false;
  }
}

/**
 * Protect cron/admin endpoints with CRON_SECRET.
 * Accepts ?token= or Authorization: Bearer (Vercel Cron sends the latter).
 * Secret resolution order: 设置弹窗（app_settings 表，30s 缓存）→ 环境变量 CRON_SECRET。
 * In production/Vercel, a secret must be configured somewhere.
 */
export async function assertCronAuth(req, res) {
  // 桌面端本地调度:主进程调用自身服务,无需 secret。但随机端口监听 127.0.0.1,
  // 恶意网页可用 <img>/<link>/表单等子资源请求无鉴权触发本地管线(消耗用户 LLM 额度)。
  // 浏览器子资源 GET 一律不带 Origin 头 → 必须连"无 Origin"一起拒绝;调度器的
  // callCron 显式携带本机 Origin 头,不受影响(见 electron/scheduler.js)。
  if (process.env.DESKTOP_MODE === '1') {
    if (!isLocalOrigin(req.headers.origin, req.headers.host)) {
      res.status(403).json({ error: 'Forbidden origin' });
      return false;
    }
    return true;
  }
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
