import crypto from 'crypto';
import { getAuthDb } from './authDb';

/**
 * 登录认证（单账号模式）：
 * - app_account 存 scrypt 密码哈希 + 盐；首次启动种子账号 admin，初始密码
 *   取 ADMIN_INITIAL_PASSWORD（部署者可显式配置），否则随机生成并打印到日志一次
 *   —— 不再硬编码弱口令（admin1234 曾默认种子，公网部署后未改密即被接管）
 * - 登录成功签发随机 token 存 app_session（httpOnly cookie，30 天有效）
 * - middleware 与 /api/auth/me 校验 cookie → 账号名
 */

export const SESSION_COOKIE = 'fs_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 会话 token 存库前哈希（SHA-256）：DB 泄露时无法直接冒用会话；旧版明文
 * token 行在 v4 迁移后因 user_id 为 NULL 而自然失效（JOIN 匹配不到）。
 * 导出供测试直接复用（避免测试复制实现造成分叉）。 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 随机初始密码（12 字节 = 96 位熵，URL-safe base64url 编码，16 字符）。 */
function randomPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * 无账号时创建默认账号。初始密码：环境变量 ADMIN_INITIAL_PASSWORD 优先（部署者
 * 显式配置，适合首启初始化脚本）；否则随机生成，仅在创建时打印一次到日志
 * （本地开发可见；生产请通过 env 配置或创建后立即在「设置 → 账户」修改）。
 */
export async function ensureDefaultAccount(): Promise<void> {
  const db = await getAuthDb();
  const row = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] });
  if (Number(row.rows[0].n) === 0) {
    const username = process.env.ADMIN_INITIAL_USERNAME || 'admin';
    const explicit = process.env.ADMIN_INITIAL_PASSWORD;
    const initialPassword = explicit || randomPassword();
    const { hash, salt } = hashPassword(initialPassword);
    // B6:并发首启两个请求同时 COUNT=0 时,第二个 INSERT 撞 UNIQUE(username)
    // 会被 OR IGNORE 静默吞掉(而非 500)——种子账号只建一次
    const inserted = await db.execute({
      sql: 'INSERT OR IGNORE INTO app_account (username, password_hash, salt) VALUES (?, ?, ?)',
      args: [username, hash, salt],
    });
    if (!explicit && inserted.rowsAffected === 1) {
      // 随机初始密码只此一次输出；用户登录后应立即在「设置 → 账户」修改密码
      console.warn(
        `[auth] 已创建默认账号 "${username}"，初始密码: ${initialPassword} —— 请登录后立即修改密码。` +
        (process.env.VERCEL ? '（生产环境建议设置 ADMIN_INITIAL_PASSWORD 环境变量）' : '')
      );
    }
  }
}

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 校验账号密码；成功签发会话 token 并返回（失败返回 null）。 */
export async function login(username: string, password: string): Promise<string | null> {
  await ensureDefaultAccount();
  const db = await getAuthDb();
  const row = await db.execute({
    sql: 'SELECT id, username, password_hash, salt FROM app_account WHERE username = ?',
    args: [username.trim()],
  });
  if (row.rows.length === 0 || !verifyPassword(password, String(row.rows[0].password_hash), String(row.rows[0].salt))) {
    // 失败延迟：scrypt 校验本身已有成本，叠加固定延迟压低在线爆破速率
    await new Promise((r) => setTimeout(r, 400));
    return null;
  }
  const acc = row.rows[0] as Record<string, unknown>;

  // B5:256 位随机熵,固定 randomBytes(32) 熵源——不设 randomUUID fallback:
  // globalThis.crypto 在 Node 19+ 才默认全局,Node 18 需 flag;fallback 反而
  // 引入 Date.now+Math.random 弱熵路径(见 createAgentShare 同款注释)。
  // 存库前 SHA-256(B2),明文只出现在响应 cookie 里
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.execute({
    sql: 'INSERT INTO app_session (token, user_id, expires_at) VALUES (?, ?, ?)',
    args: [hashToken(token), Number(acc.id), expires],
  });
  return token;
}

/** token 有效且未过期 → 返回账号名；否则 null。
 * 滑动续期节流：仅当剩余有效期不足 1/3 时才延长 expires_at（原实现每次请求
 * 都 UPDATE 写库——每请求一次写放大）；顺带概率性清理过期会话（防表无限膨胀）。 */
export async function getSessionUser(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const db = await getAuthDb();
  const h = hashToken(token);
  const row = await db.execute({
    sql: 'SELECT a.username, s.expires_at FROM app_session s JOIN app_account a ON a.id = s.user_id WHERE s.token = ? LIMIT 1',
    args: [h],
  });
  if (row.rows.length === 0) return null;
  const acc = row.rows[0] as Record<string, unknown>;
  const expiresAt = new Date(String(acc.expires_at)).getTime();
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) return null;

  const remaining = expiresAt - Date.now();
  if (remaining < SESSION_TTL_MS / 3) {
    // 续期失败不影响鉴权(Turso 远程瞬断时不能把有效会话打成 500),与清理同款兜底
    try {
      await db.execute({
        sql: 'UPDATE app_session SET expires_at = ? WHERE token = ?',
        args: [new Date(Date.now() + SESSION_TTL_MS).toISOString(), h],
      });
    } catch { /* 续期失败:会话仍有效到原期限 */ }
  }
  // 过期行清理:低概率触发即可(高频端点不该每次写库),失败不影响鉴权。
  // OR user_id IS NULL:v4 迁移后旧明文死行(user_id 为 NULL,JOIN 匹配不到)顺带清除
  if (Math.random() < 0.05) {
    try {
      await db.execute({
        sql: 'DELETE FROM app_session WHERE expires_at <= ? OR user_id IS NULL',
        args: [new Date().toISOString()],
      });
    } catch { /* 清理失败不影响主流程 */ }
  }
  return String(acc.username);
}

export async function logout(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const db = await getAuthDb();
  await db.execute({ sql: 'DELETE FROM app_session WHERE token = ?', args: [hashToken(token)] });
}

export interface ChangeAccountResult {
  ok: boolean;
  error?: string;
}

/**
 * 修改登录名/密码（需当前密码验证）。
 * 修改登录名时校验唯一性；密码至少 6 位。
 */
export async function changeAccount(opts: {
  currentPassword: string;
  username?: string;
  password?: string;
}): Promise<ChangeAccountResult> {
  await ensureDefaultAccount();
  const db = await getAuthDb();
  const row = await db.execute({ sql: 'SELECT id, username, password_hash, salt FROM app_account LIMIT 1', args: [] });
  if (row.rows.length === 0) return { ok: false, error: '账号不存在' };
  const acc = row.rows[0] as Record<string, unknown>;
  if (!verifyPassword(opts.currentPassword, String(acc.password_hash), String(acc.salt))) {
    // 与 login 同款失败延迟:该端点校验的是"改密钥匙",无延迟等于凭据接管的高速通道
    await new Promise((r) => setTimeout(r, 400));
    return { ok: false, error: '当前密码不正确' };
  }

  const nextUsername = opts.username?.trim() ?? String(acc.username);
  if (nextUsername.length < 2) return { ok: false, error: '登录名至少 2 个字符' };
  if (nextUsername !== String(acc.username)) {
    const exists = await db.execute({ sql: 'SELECT id FROM app_account WHERE username = ?', args: [nextUsername] });
    if (exists.rows.length > 0) return { ok: false, error: '登录名已存在' };
  }
  if (opts.password && opts.password.length < 6) {
    return { ok: false, error: '新密码至少 6 位' };
  }

  const usernameChanged = nextUsername !== String(acc.username);
  const passwordChanged = Boolean(opts.password);
  if (!usernameChanged && !passwordChanged) {
    // 没有任何实际变更(如前端误提交)不吊销会话
    return { ok: true };
  }
  // UPDATE + DELETE 同批原子提交(单事务):任一步失败都不留下
  // "密码已改但会话未清"或"会话已清但密码未改"的中间态
  const statements = [];
  if (passwordChanged) {
    const { hash, salt } = hashPassword(opts.password);
    statements.push({
      sql: 'UPDATE app_account SET username = ?, password_hash = ?, salt = ? WHERE id = ?',
      args: [nextUsername, hash, salt, acc.id],
    });
  } else {
    statements.push({ sql: 'UPDATE app_account SET username = ? WHERE id = ?', args: [nextUsername, acc.id] });
  }
  // B1:凭据变更后吊销全部会话——已泄露的会话 cookie 不得在改密/改名后继续有效
  // (单账号模式:清空即当前用户重登,成本可忽略)
  statements.push({ sql: 'DELETE FROM app_session', args: [] });
  await db.batch(statements);
  return { ok: true };
}

/** 会话 cookie 序列化（httpOnly + SameSite=Lax，生产环境加 Secure）。 */
export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
