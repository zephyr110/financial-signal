import path from 'path';
import { createClient, type Client } from '@libsql/client';
import { getDb } from './db';

/**
 * 桌面端认证库：与 news_archive.db 分离,避免登录(ensureDefaultAccount)
 * 抢先创建主库文件 → getInfo.imported 恒 true → 首启欢迎页永不出现。
 * Web 或未配置 AUTH_DB_PATH 时回退到主库 getDb()。
 */
let authClient: Client | undefined;
let authSchemaReady: Promise<void> | undefined;

function resolveAuthDbPath(): string | null {
  if (process.env.AUTH_DB_PATH) return process.env.AUTH_DB_PATH;
  if (process.env.DESKTOP_MODE === '1') {
    const newsPath = process.env.NEWS_DB_PATH || path.join(process.cwd(), 'news_archive.db');
    return path.join(path.dirname(newsPath), 'auth.db');
  }
  return null;
}

async function ensureAuthSchema(db: Client): Promise<void> {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS app_account (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      salt          TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_session (
      token      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      user_id    INTEGER REFERENCES app_account(id)
    );
  `);
}

export async function getAuthDb(): Promise<Client> {
  const authPath = resolveAuthDbPath();
  if (!authPath) return getDb();

  if (!authClient) {
    authClient = createClient({ url: `file:${authPath}` });
  }
  let m = authSchemaReady;
  if (!m) {
    m = ensureAuthSchema(authClient);
    authSchemaReady = m;
  }
  try {
    await m;
  } catch (err) {
    if (authSchemaReady === m) authSchemaReady = undefined;
    throw err;
  }
  return authClient;
}

/** 测试/热重载:重置认证库单例(不影响主库 client)。 */
export function resetAuthDbForTests(): void {
  authClient = undefined;
  authSchemaReady = undefined;
}
