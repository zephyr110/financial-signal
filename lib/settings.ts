import { getDb } from './db';

/**
 * 运行设置（app_settings 表）：用户在「设置」弹窗中配置，运行时覆盖环境变量。
 * 读取带 30s 内存缓存（LLM 配置热生效，无需重启）；
 * 写入后立即失效缓存。
 */

const CACHE_TTL_MS = 30_000;

export const SETTING_KEYS = {
  LLM_MODEL: 'llm_model',
  LLM_BASE_URL: 'llm_base_url',
  LLM_API_KEY: 'llm_api_key',
  TURSO_DATABASE_URL: 'turso_database_url',
  TURSO_AUTH_TOKEN: 'turso_auth_token',
  TUSHARE_TOKEN: 'tushare_token',
  CRON_SECRET: 'cron_secret',
} as const;

let cache: { at: number; data: Record<string, string> } | null = null;

export async function getAllSettings(force = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.data;
  const db = await getDb();
  const rows = await db.execute({ sql: 'SELECT key, value FROM app_settings', args: [] });
  const data: Record<string, string> = {};
  for (const r of rows.rows) data[String(r.key)] = String(r.value);
  cache = { at: now, data };
  return data;
}

export async function getSetting(key: string): Promise<string | null> {
  const all = await getAllSettings();
  return all[key] ?? null;
}

/** 批量写设置：value 为 '' 或 null 表示清除该项。写后失效缓存。 */
export async function setSettings(patch: Record<string, string | null | undefined>): Promise<void> {
  const db = await getDb();
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || value === '') {
      await db.execute({ sql: 'DELETE FROM app_settings WHERE key = ?', args: [key] });
    } else {
      await db.execute({
        sql: `INSERT INTO app_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        args: [key, value],
      });
    }
  }
  cache = null;
}
