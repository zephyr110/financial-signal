import { describe, it, expect, beforeEach, vi } from 'vitest';
import handler from '../pages/api/agent-branches';
import { agentSessionExists, selectAgentMessageVersion } from '../lib/db';

vi.mock('../lib/db', () => ({
  agentSessionExists: vi.fn(),
  selectAgentMessageVersion: vi.fn(),
}));
vi.mock('../lib/request-user', () => ({
  requestUserId: vi.fn().mockResolvedValue(7),
}));

function mockReq(method = 'POST', body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return { method, body, headers };
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    _headers: {},
    status(code: number) { this._status = code; return this; },
    setHeader(name: string, value: unknown) { this._headers[name] = value; return this; },
    json(body: unknown) { this._body = body; return this; },
  };
  return res;
}

describe('POST /api/agent-branches', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(agentSessionExists).mockReset();
    vi.mocked(selectAgentMessageVersion).mockReset();
  });

  it('切换成功 → 200', async () => {
    vi.mocked(agentSessionExists).mockResolvedValue(true);
    vi.mocked(selectAgentMessageVersion).mockResolvedValue(true);
    const res = mockRes();
    await handler(mockReq('POST', { sessionId: 3, messageId: 12 }), res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, sessionId: 3, messageId: 12 });
    expect(selectAgentMessageVersion).toHaveBeenCalledWith(3, 12);
  });

  it('非 POST → 405', async () => {
    const res = mockRes();
    await handler(mockReq('GET'), res);
    expect(res._status).toBe(405);
    expect(res._headers.Allow).toEqual(['POST']);
    expect(agentSessionExists).not.toHaveBeenCalled();
  });

  it('参数非法 → 400', async () => {
    for (const body of [{}, { sessionId: 0, messageId: 1 }, { sessionId: 1, messageId: -2 }, { sessionId: 'x', messageId: 1 }]) {
      const res = mockRes();
      await handler(mockReq('POST', body), res);
      expect(res._status).toBe(400);
    }
    expect(agentSessionExists).not.toHaveBeenCalled();
  });

  it('会话不存在 → 404', async () => {
    vi.mocked(agentSessionExists).mockResolvedValue(false);
    const res = mockRes();
    await handler(mockReq('POST', { sessionId: 9, messageId: 1 }), res);
    expect(res._status).toBe(404);
    expect(selectAgentMessageVersion).not.toHaveBeenCalled();
  });

  it('消息不可切换 → 404', async () => {
    vi.mocked(agentSessionExists).mockResolvedValue(true);
    vi.mocked(selectAgentMessageVersion).mockResolvedValue(false);
    const res = mockRes();
    await handler(mockReq('POST', { sessionId: 3, messageId: 999 }), res);
    expect(res._status).toBe(404);
  });

  it('数据库异常 → 500', async () => {
    vi.mocked(agentSessionExists).mockRejectedValue(new Error('db down'));
    const res = mockRes();
    await handler(mockReq('POST', { sessionId: 3, messageId: 1 }), res);
    expect(res._status).toBe(500);
  });

  it('桌面模式跨站 Origin → 403', async () => {
    vi.stubEnv('DESKTOP_MODE', '1');
    const res = mockRes();
    await handler(
      mockReq('POST', { sessionId: 3, messageId: 1 }, { origin: 'https://evil.example', host: '127.0.0.1:3010' }),
      res,
    );
    expect(res._status).toBe(403);
    expect(agentSessionExists).not.toHaveBeenCalled();
  });
});
