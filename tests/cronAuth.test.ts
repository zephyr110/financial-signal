import path from 'path'
import os from 'os'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { assertCronAuth } from '../lib/cronAuth'
import { setSettings, SETTING_KEYS } from '../lib/settings'

// 隔离 DB：settings 写入不能落在共享的项目 DB（并行 worker 会互相污染/锁冲突）
process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-cronauth-${process.pid}.db`)

function mockReq(query = {}, headers = {}) {
  return { query, headers }
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { this._status = code; return this },
    json(body: any) { this._body = body; return this },
  }
  return res
}

describe('assertCronAuth', () => {
  beforeEach(async () => {
    vi.unstubAllEnvs()
    // 清掉 settings 表中可能残留的 cron_secret（测试之间共享 in-memory DB）
    await setSettings({ [SETTING_KEYS.CRON_SECRET]: null })
  })

  it('allows local dev without CRON_SECRET', async () => {
    const res = mockRes()
    expect(await assertCronAuth(mockReq(), res)).toBe(true)
  })

  it('rejects on Vercel without CRON_SECRET', async () => {
    vi.stubEnv('VERCEL', '1')
    const res = mockRes()
    expect(await assertCronAuth(mockReq(), res)).toBe(false)
    expect(res._status).toBe(503)
  })

  it('rejects in production without CRON_SECRET', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const res = mockRes()
    expect(await assertCronAuth(mockReq(), res)).toBe(false)
    expect(res._status).toBe(503)
  })

  it('accepts token in query', async () => {
    vi.stubEnv('CRON_SECRET', 'secret123')
    const res = mockRes()
    expect(await assertCronAuth(mockReq({ token: 'secret123' }), res)).toBe(true)
  })

  it('rejects wrong token', async () => {
    vi.stubEnv('CRON_SECRET', 'secret123')
    const res = mockRes()
    expect(await assertCronAuth(mockReq({ token: 'wrong' }), res)).toBe(false)
    expect(res._status).toBe(401)
  })

  it('accepts Bearer token', async () => {
    vi.stubEnv('CRON_SECRET', 'secret123')
    const res = mockRes()
    expect(await assertCronAuth(mockReq({}, { authorization: 'Bearer secret123' }), res)).toBe(true)
  })

  it('uses cron secret from settings (设置) with env fallback', async () => {
    vi.stubEnv('CRON_SECRET', 'env-secret')
    await setSettings({ [SETTING_KEYS.CRON_SECRET]: 'db-secret' })
    const res = mockRes()
    expect(await assertCronAuth(mockReq({ token: 'db-secret' }), res)).toBe(true)
    expect(await assertCronAuth(mockReq({ token: 'env-secret' }), res)).toBe(false)
  })
})

describe('DESKTOP_MODE', () => {
  it('bypasses auth when DESKTOP_MODE=1 even without secret (需本机 Origin)', async () => {
    // VERCEL=1 让"无 secret 即 503"分支生效:若无 DESKTOP_MODE 守卫,此用例必然失败(强判别)
    const prevDesktopMode = process.env.DESKTOP_MODE;
    const prevVercel = process.env.VERCEL;
    process.env.DESKTOP_MODE = '1';
    process.env.VERCEL = '1';
    try {
      // 调度器/渲染层请求带本机 Origin(端口与本请求 Host 一致);无 Origin 的子资源请求(恶意网页 img 等)走另一用例的 403
      const req = { query: {}, headers: { origin: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' } };
      const res = { status: () => ({ json: () => {} }) };
      expect(await assertCronAuth(req, res)).toBe(true);
    } finally {
      if (prevDesktopMode === undefined) delete process.env.DESKTOP_MODE;
      else process.env.DESKTOP_MODE = prevDesktopMode;
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
    }
  });

  it('blocks cross-site Origin in DESKTOP_MODE (browser CSRF guard)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const res = mockRes();
    expect(await assertCronAuth(mockReq({}, { origin: 'https://evil.example' }), res)).toBe(false);
    expect(res._status).toBe(403);
  });

  it('blocks requests without an Origin in DESKTOP_MODE (img/link/form 子资源 CSRF)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const res = mockRes();
    expect(await assertCronAuth(mockReq(), res)).toBe(false);
    expect(res._status).toBe(403);
  });

  it('allows local page Origins in DESKTOP_MODE when port matches Host', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const res = mockRes();
    expect(await assertCronAuth(mockReq({}, { origin: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' }), res)).toBe(true);
    expect(await assertCronAuth(mockReq({}, { origin: 'http://localhost:3010', host: '127.0.0.1:3010' }), res)).toBe(true);
  });

  it('blocks local Origin whose port differs from Host (同机其他本地服务)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const res = mockRes();
    // 恶意本地服务在 9999 端口,向 3010 端口发跨源请求 → 端口不匹配,拒绝
    expect(await assertCronAuth(mockReq({}, { origin: 'http://localhost:9999', host: '127.0.0.1:3010' }), res)).toBe(false);
    expect(res._status).toBe(403);
  });

  it('web mode ignores Origin (behavior unchanged)', async () => {
    // DESKTOP_MODE describe 没有 beforeEach:先清掉前一个用例残留的 DESKTOP_MODE stub
    vi.unstubAllEnvs();
    // 写库并失效 30s 缓存,确定性拿到 web-secret(不受 assertCronAuth describe 里共享 DB 状态影响)
    await setSettings({ [SETTING_KEYS.CRON_SECRET]: 'web-secret' });
    const res = mockRes();
    // 带恶意 Origin + 正确 token:web 模式仍按 secret 鉴权,Origin 不参与
    expect(await assertCronAuth(mockReq({ token: 'web-secret' }, { origin: 'https://evil.example' }), res)).toBe(true);
    // 错误 token 仍是 401(而非 403):证明 web 模式只走 secret 鉴权
    expect(await assertCronAuth(mockReq({ token: 'wrong' }, { origin: 'https://evil.example' }), res)).toBe(false);
    expect(res._status).toBe(401);
  });
});
