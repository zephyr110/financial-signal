import { getSessionUser, SESSION_COOKIE } from '../../lib/auth';
import { getAllSettings, setSettings, SETTING_KEYS } from '../../lib/settings';
import { getActiveDbTarget } from '../../lib/db';
import { describeDbStorage, isDbBackendLocked, readDbConfig, writeDbConfig, type DbStorageStatus, type StoredDbConfig } from '../../lib/db-config';
import { isLocalOrigin } from '../../lib/cronAuth';
import { probeTurso } from '../../lib/turso-probe';
import { sanitizeErrorMessage } from '../../lib/safe-json';

function sameDbConfig(a: StoredDbConfig | null, b: StoredDbConfig | null): boolean {
  if (!a || !b) return a === b;
  return a.backend === b.backend
    && (a.tursoUrl ?? '') === (b.tursoUrl ?? '')
    && (a.tursoToken ?? '') === (b.tursoToken ?? '');
}

/** 存储状态只读配置文件，不应因连接失败而让整个设置页不可用。 */
function readStorageStatus(): DbStorageStatus {
  try {
    return describeDbStorage(process.env, readDbConfig(), getActiveDbTarget());
  } catch (error) {
    console.error('[api/settings] storage status failed:', error);
    const active = getActiveDbTarget();
    // 解析配置都抛错时通常来自坏掉的环境变量；锁住切换，避免把配置写得更坏。
    return {
      backend: 'local',
      source: 'default',
      locked: true,
      urlSet: false,
      tokenSet: false,
      activeBackend: active && !active.url.startsWith('file:') ? 'turso' : 'local',
      restartRequired: false,
    };
  }
}

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
    let all: Record<string, string> | null = null;
    try {
      all = await getAllSettings();
    } catch (error) {
      // 远端库连不上时仍要给出存储状态，否则用户没有入口切回本地库。
      console.error('[api/settings] read settings failed:', error);
    }
    const has = (key: string) => Boolean(all?.[key]);
    res.status(200).json({
      settingsUnavailable: all === null,
      llm: {
        model: all?.[SETTING_KEYS.LLM_MODEL] ?? '',
        baseUrl: all?.[SETTING_KEYS.LLM_BASE_URL] ?? '',
        apiKeySet: has(SETTING_KEYS.LLM_API_KEY),
      },
      storage: readStorageStatus(),
      tushare: {
        tokenSet: has(SETTING_KEYS.TUSHARE_TOKEN),
      },
      webSearch: {
        provider: all?.[SETTING_KEYS.WEB_SEARCH_PROVIDER] ?? '',
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
    const storageRequested = storageBackend != null;
    if (storageRequested) {
      if (isDbBackendLocked(process.env)) {
        return res.status(400).json({ error: '数据库后端由环境变量控制，无法在设置中切换' });
      }
      const backend = String(storageBackend).trim().toLowerCase();
      if (backend !== 'local' && backend !== 'turso') {
        return res.status(400).json({ error: '数据库后端只能是 local 或 turso' });
      }
      const before = readDbConfig();
      if (backend === 'turso') {
        const url = String(tursoUrl ?? '').trim() || before?.tursoUrl || '';
        if (!url) return res.status(400).json({ error: '使用 Turso 需要填写数据库 URL' });
        if (!/^(libsql|https?):\/\//i.test(url)) {
          return res.status(400).json({ error: 'Turso 数据库 URL 应以 libsql:// 或 https:// 开头' });
        }
        // token 未传/留空 = 沿用已保存的值；显式 null = 清除
        let token = before?.tursoToken;
        if (tursoToken === null) token = undefined;
        else if (typeof tursoToken === 'string' && tursoToken.trim()) token = tursoToken.trim();
        const candidate: StoredDbConfig = {
          backend: 'turso',
          tursoUrl: url,
          ...(token ? { tursoToken: token } : {}),
        };
        if (!sameDbConfig(before, candidate)) {
          // 写盘前先验证地址/token：保存后必须重启，连不上就没有机会在 UI 里改回来。
          // 显式清除 token 且地址未变时无凭据可探，直接落盘——否则永远删不掉。
          const clearingToken = tursoToken === null && before?.tursoUrl === url;
          if (!clearingToken) {
            try {
              await probeTurso(url, token);
            } catch (error) {
              return res.status(400).json({
                error: `无法连接 Turso：${sanitizeErrorMessage(error instanceof Error ? error.message : String(error))}`,
              });
            }
          }
          nextDbConfig = candidate;
        }
      } else {
        // 切回本地时保留 Turso 凭据，再次切换无需重新输入；显式 null 才清除。
        const keepToken = tursoToken === null ? undefined : before?.tursoToken;
        const candidate: StoredDbConfig = {
          backend: 'local',
          ...(before?.tursoUrl ? { tursoUrl: before.tursoUrl } : {}),
          ...(keepToken ? { tursoToken: keepToken } : {}),
        };
        if (!sameDbConfig(before, candidate)) nextDbConfig = candidate;
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
      // 存储配置没有变化也是成功保存，不能报"没有需要保存的配置"。
      if (storageRequested) return res.status(200).json({ ok: true });
      return res.status(400).json({ error: '没有需要保存的配置' });
    }

    let restartRequired = false;
    try {
      if (Object.keys(patch).length > 0) await setSettings(patch);
      if (nextDbConfig) {
        writeDbConfig(nextDbConfig);
        // DB 客户端在首次 getDb() 时已固定；只有实际连接与落盘配置不一致才需重启。
        restartRequired = describeDbStorage(process.env, nextDbConfig, getActiveDbTarget()).restartRequired;
      }
    } catch (error) {
      console.error('[api/settings] Error:', error);
      return res.status(500).json({ error: '保存失败，请稍后重试' });
    }
    res.status(200).json({ ok: true, ...(restartRequired ? { restartRequired: true } : {}) });
    return;
  }

  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).json({ error: `Method ${req.method} not allowed` });
}
