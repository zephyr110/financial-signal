import fs from 'fs';
import path from 'path';

/**
 * 数据库后端的启动配置。
 *
 * 后端选择必须在连库之前生效，因此不能存在 app_settings 表里；单独存
 * 本地 JSON（与 news_archive.db 同目录），默认本地库，Turso 仅在显式选择时使用。
 * 环境变量 DB_BACKEND / VERCEL 仍然优先，供部署环境锁定后端。
 */
export type DbBackend = 'local' | 'turso';

export interface StoredDbConfig {
  backend: DbBackend;
  tursoUrl?: string;
  tursoToken?: string;
}

export interface DbTarget {
  url: string;
  authToken?: string;
}

interface DbResolution {
  target: DbTarget;
  backend: DbBackend;
  source: 'env' | 'settings' | 'default';
  locked: boolean;
  urlSet: boolean;
  tokenSet: boolean;
}

export interface DbStorageStatus {
  backend: DbBackend;
  source: 'env' | 'settings' | 'default';
  locked: boolean;
  urlSet: boolean;
  tokenSet: boolean;
  activeBackend: DbBackend;
  restartRequired: boolean;
}

export function dbConfigPath(env: Record<string, string | undefined> = process.env): string {
  if (env.DB_CONFIG_PATH) return env.DB_CONFIG_PATH;
  const dbFile = env.NEWS_DB_PATH || path.join(process.cwd(), 'news_archive.db');
  return path.join(path.dirname(dbFile), 'db-config.json');
}

/** 读不到/格式不对时返回 null（回退默认本地库），不让坏文件拖垮启动。 */
export function readDbConfig(file: string = dbConfigPath()): StoredDbConfig | null {
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.backend !== 'local' && raw.backend !== 'turso') return null;
  const tursoUrl = typeof raw.tursoUrl === 'string' ? raw.tursoUrl.trim() : '';
  const tursoToken = typeof raw.tursoToken === 'string' ? raw.tursoToken.trim() : '';
  if (raw.backend === 'turso' && !tursoUrl) return null;
  return {
    backend: raw.backend,
    ...(tursoUrl ? { tursoUrl } : {}),
    ...(tursoToken ? { tursoToken } : {}),
  };
}

/** 原子写入；含鉴权 token，权限收紧到 600。 */
export function writeDbConfig(config: StoredDbConfig, file: string = dbConfigPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略
  }
}

function localTarget(env: Record<string, string | undefined>): DbTarget {
  const filePath = env.NEWS_DB_PATH || path.join(process.cwd(), 'news_archive.db');
  return { url: `file:${filePath}` };
}

function resolveDbResolution(
  env: Record<string, string | undefined>,
  stored: StoredDbConfig | null,
): DbResolution {
  if (env.NODE_ENV === 'test') {
    return {
      target: localTarget(env),
      backend: 'local',
      source: 'default',
      locked: false,
      urlSet: false,
      tokenSet: false,
    };
  }

  const envBackend = (env.DB_BACKEND || '').trim().toLowerCase();
  if (envBackend && envBackend !== 'local' && envBackend !== 'turso') {
    throw new Error(`DB_BACKEND 只能是 local 或 turso（当前 "${envBackend}"）`);
  }
  if (envBackend === 'turso') {
    if (!env.TURSO_DATABASE_URL) {
      throw new Error('DB_BACKEND=turso 需要 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN');
    }
    return {
      target: { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN },
      backend: 'turso',
      source: 'env',
      locked: true,
      urlSet: true,
      tokenSet: Boolean(env.TURSO_AUTH_TOKEN),
    };
  }
  if (envBackend === 'local') {
    if (env.VERCEL) {
      throw new Error('Vercel 无持久磁盘，不能使用本地数据库；请删除 DB_BACKEND=local 并配置 TURSO_DATABASE_URL。');
    }
    return {
      target: localTarget(env),
      backend: 'local',
      source: 'env',
      locked: true,
      urlSet: false,
      tokenSet: false,
    };
  }

  // 未显式指定后端时，Vercel 只能走 Turso
  if (env.VERCEL) {
    if (!env.TURSO_DATABASE_URL) {
      throw new Error('Vercel 无持久磁盘，请配置 TURSO_DATABASE_URL 与 TURSO_AUTH_TOKEN。');
    }
    return {
      target: { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN },
      backend: 'turso',
      source: 'env',
      locked: true,
      urlSet: true,
      tokenSet: Boolean(env.TURSO_AUTH_TOKEN),
    };
  }

  if (stored?.backend === 'turso' && stored.tursoUrl) {
    return {
      target: { url: stored.tursoUrl, authToken: stored.tursoToken },
      backend: 'turso',
      source: 'settings',
      locked: false,
      urlSet: true,
      tokenSet: Boolean(stored.tursoToken),
    };
  }

  return {
    target: localTarget(env),
    backend: 'local',
    source: stored ? 'settings' : 'default',
    locked: false,
    urlSet: false,
    tokenSet: false,
  };
}

export function resolveDbTarget(
  env: Record<string, string | undefined> = process.env,
  stored: StoredDbConfig | null = null,
): DbTarget {
  return resolveDbResolution(env, stored).target;
}

export function isDbBackendLocked(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VERCEL || (env.DB_BACKEND || '').trim());
}

/**
 * 设置页展示用：区分「当前进程实际连的库」与「下次启动会连的库」，
 * 切换后端后 UI 才能提示需要重启。
 */
export function describeDbStorage(
  env: Record<string, string | undefined>,
  stored: StoredDbConfig | null,
  activeTarget: DbTarget | null,
): DbStorageStatus {
  const r = resolveDbResolution(env, stored);
  const activeBackend: DbBackend = activeTarget
    ? activeTarget.url.startsWith('file:') ? 'local' : 'turso'
    : r.backend;
  // DB 客户端在首次 getDb 时固定；同后端改 URL/token 同样需要重启
  const credentialsChanged = activeTarget
    ? activeTarget.url !== r.target.url
      || (activeTarget.authToken ?? '') !== (r.target.authToken ?? '')
    : false;
  return {
    backend: r.backend,
    source: r.source,
    locked: r.locked,
    urlSet: r.urlSet,
    tokenSet: r.tokenSet,
    activeBackend,
    restartRequired: activeBackend !== r.backend || credentialsChanged,
  };
}
