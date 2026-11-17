import { getSessionUser, SESSION_COOKIE } from '../../lib/auth';
import { getAllSettings, setSettings, SETTING_KEYS } from '../../lib/settings';
import { getActiveDbTarget } from '../../lib/db';
import { describeDbStorage, isDbBackendLocked, readDbConfig, writeDbConfig, type StoredDbConfig } from '../../lib/db-config';
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
      storage: describeDbStorage(process.env, readDbConfig(), getActiveDbTarget()),
      tushare: {
        tokenSet: has(SETTING_KEYS.TUSHARE_TOKEN),
      },
      webSearch: {
        provider: all[SETTING_KEYS.WEB_SEARCH_PROVIDER] ?? '',
        apiKeySet: has(SETTING_KEYS.WEB_SEARCH_API_KEY),
      },
      cronSecretSet: has(SETTING_KEYS.CRON_SECRET),
    });
    return;
  }

  if (req.method === 'POST') {
    const {
      llmModel, llmBaseUrl, llmApiKey, tushareToken, cronSecret,
      webSearchProvider, webSearchApiKey,
      storageBackend, tursoUrl, tursoToken,
    } = req.body || {};

    let nextDbConfig: StoredDbConfig | null = null;
    if (storageBackend != null) {
      if (isDbBackendLocked(process.env)) {
        return res.status(400).json({ error: '数据库后端由环境变量控制，无法在设置中切换' });
      }
      const backend = String(storageBackend).trim().toLowerCase();
      if (backend !== 'local' && backend !== 'turso') {
        return res.status(400).json({ error: '数据库后端只能是 local 或 turso' });
      }
      if (backend === 'turso') {
        const before = readDbConfig();
        const url = String(tursoUrl ?? '').trim() || before?.tursoUrl || '';
        if (!url) return res.status(400).json({ error: '使用 Turso 需要填写数据库 URL' });
        if (!/^(libsql|https?):\/\//i.test(url)) {
          return res.status(400).json({ error: 'Turso 数据库 URL 应以 libsql:// 或 https:// 开头' });
        }
        // token 未传/留空 = 沿用已保存的值；显式 null = 清除
        let token = before?.tursoToken;
        if (tursoToken === null) token = undefined;
        else if (typeof tursoToken === 'string' && tursoToken.trim()) token = tursoToken.trim();
        nextDbConfig = { backend: 'turso', tursoUrl: url, ...(token ? { tursoToken: token } : {}) };
      } else {
        nextDbConfig = { backend: 'local' };
      }
    }

    // 留空字符串 = 保持不变；未传 = 忽略；只有显式 null 才清除
    const patch: Record<string, string | null> = {};
    if (llmModel != null) patch[SETTING_KEYS.LLM_MODEL] = llmModel === '' ? null : String(llmModel).trim();
    if (llmBaseUrl != null) patch[SETTING_KEYS.LLM_BASE_URL] = llmBaseUrl === '' ? null : String(llmBaseUrl).trim().replace(/\/+$/, '');
    if (llmApiKey != null) patch[SETTING_KEYS.LLM_API_KEY] = llmApiKey === '' ? null : String(llmApiKey).trim();
    if (tushareToken != null) patch[SETTING_KEYS.TUSHARE_TOKEN] = tushareToken === '' ? null : String(tushareToken).trim();
    if (cronSecret != null) patch[SETTING_KEYS.CRON_SECRET] = cronSecret === '' ? null : String(cronSecret).trim();
    if (webSearchProvider != null) {
      const provider = String(webSearchProvider).trim().toLowerCase();
      if (provider && provider !== 'bocha' && provider !== 'tavily') {
        return res.status(400).json({ error: '联网搜索服务商只能是 bocha 或 tavily' });
      }
      patch[SETTING_KEYS.WEB_SEARCH_PROVIDER] = provider || null;
    }
    if (webSearchApiKey != null) {
      patch[SETTING_KEYS.WEB_SEARCH_API_KEY] = webSearchApiKey === '' ? null : String(webSearchApiKey).trim();
    }
    if (Object.keys(patch).length === 0 && !nextDbConfig) {
      return res.status(400).json({ error: '没有需要保存的配置' });
    }

    try {
      if (Object.keys(patch).length > 0) await setSettings(patch);
      if (nextDbConfig) writeDbConfig(nextDbConfig);
    } catch (error) {
      console.error('[api/settings] Error:', error);
      return res.status(500).json({ error: '保存失败，请稍后重试' });
    }
    // 后端/凭据变了就必须重启：DB 客户端在首次 getDb() 时已固定，不能热切
    res.status(200).json({ ok: true, ...(nextDbConfig ? { restartRequired: true } : {}) });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed` });
}
