import { getSessionUser, SESSION_COOKIE } from '../../lib/auth';
import { getAllSettings, setSettings, SETTING_KEYS } from '../../lib/settings';
import { isLocalOrigin } from '../../lib/cronAuth';

/**
 * 运行设置：
 * - GET  → 当前配置（密钥类仅返回是否已设置，不回传明文）
 * - POST → 保存配置（密钥留空 = 不变；显式 '' 清除 —— 由 UI 约定为留空即不变）
 */
export default async function handler(req: any, res: any) {
  const username = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
  if (!username) return res.status(401).json({ error: '未登录' });

  // 桌面端 POST 额外校验本机 Origin:浏览器子资源 CSRF 防护(与会话鉴权叠加)
  if (process.env.DESKTOP_MODE === '1' && req.method === 'POST') {
    if (!isLocalOrigin(req.headers.origin, req.headers.host)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
  }

  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const all = await getAllSettings();
    const has = (key: string) => Boolean(all[key]);
    res.status(200).json({
      llm: {
        model: all[SETTING_KEYS.LLM_MODEL] ?? '',
        baseUrl: all[SETTING_KEYS.LLM_BASE_URL] ?? '',
        apiKeySet: has(SETTING_KEYS.LLM_API_KEY),
      },
      turso: {
        urlSet: has(SETTING_KEYS.TURSO_DATABASE_URL),
        tokenSet: has(SETTING_KEYS.TURSO_AUTH_TOKEN),
      },
      cronSecretSet: has(SETTING_KEYS.CRON_SECRET),
    });
    return;
  }

  if (req.method === 'POST') {
    const { llmModel, llmBaseUrl, llmApiKey, tursoUrl, tursoToken, cronSecret } = req.body || {};
    // 留空字符串 = 保持不变；未传 = 忽略；只有显式 null 才清除
    const patch: Record<string, string | null> = {};
    if (llmModel != null) patch[SETTING_KEYS.LLM_MODEL] = llmModel === '' ? null : String(llmModel).trim();
    if (llmBaseUrl != null) patch[SETTING_KEYS.LLM_BASE_URL] = llmBaseUrl === '' ? null : String(llmBaseUrl).trim().replace(/\/+$/, '');
    if (llmApiKey != null) patch[SETTING_KEYS.LLM_API_KEY] = llmApiKey === '' ? null : String(llmApiKey).trim();
    if (tursoUrl != null) patch[SETTING_KEYS.TURSO_DATABASE_URL] = tursoUrl === '' ? null : String(tursoUrl).trim();
    if (tursoToken != null) patch[SETTING_KEYS.TURSO_AUTH_TOKEN] = tursoToken === '' ? null : String(tursoToken).trim();
    if (cronSecret != null) patch[SETTING_KEYS.CRON_SECRET] = cronSecret === '' ? null : String(cronSecret).trim();
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: '没有需要保存的配置' });

    try {
      await setSettings(patch);
    } catch (error) {
      console.error('[api/settings] Error:', error);
      return res.status(500).json({ error: '保存失败，请稍后重试' });
    }
    res.status(200).json({ ok: true });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed` });
}
