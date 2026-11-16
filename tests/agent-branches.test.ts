import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeAll } from 'vitest';

// 分支树读写会开写事务,用真实临时文件库(libsql 的 :memory: 在重开连接后是空库)
process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-branches-${process.pid}.db`);

import {
  createAgentSession,
  deleteAgentSession,
  appendAgentMessage,
  forkAgentUserMessage,
  getAgentRegenerateSource,
  getAgentMessageVersions,
  selectAgentMessageVersion,
  getAgentMessages,
  compactAgentMessages,
} from '../lib/db';

const contents = async (sid: number) => (await getAgentMessages(sid)).map((r) => r.content);

describe('消息分支树', () => {
  beforeAll(async () => {
    await (await import('../lib/db')).getDb();
  });

  it('编辑根级用户消息:生成兄弟分支,旧分支保留但不可见', async () => {
    const sid = await createAgentSession('branch-edit');
    try {
      const u1 = await appendAgentMessage(sid, 'user', '问题一');
      await appendAgentMessage(sid, 'assistant', '回答一');
      await appendAgentMessage(sid, 'user', '问题二');

      const u1b = await forkAgentUserMessage(sid, u1, '问题一（改）');
      expect(u1b).toBeTruthy();
      // 新分支成为当前可见路径的根
      expect(await contents(sid)).toEqual(['问题一（改）']);

      const versions = await getAgentMessageVersions(sid);
      expect(versions[String(u1b!)].ids).toEqual([u1, u1b]);
      expect(versions[String(u1b!)].index).toBe(1);
      expect(versions[String(u1)].index).toBe(0);

      // 切回旧分支,完整旧链路恢复
      expect(await selectAgentMessageVersion(sid, u1)).toBe(true);
      expect(await contents(sid)).toEqual(['问题一', '回答一', '问题二']);
      expect((await getAgentMessageVersions(sid))[String(u1)].index).toBe(0);

      // 切回后原根消息仍可继续编辑,再切到新分支
      expect(await selectAgentMessageVersion(sid, u1b!)).toBe(true);
      expect(await contents(sid)).toEqual(['问题一（改）']);

      // 非当前可见分支上的消息不能再派生编辑
      expect(await forkAgentUserMessage(sid, u1, '越分支编辑')).toBeNull();
    } finally {
      await deleteAgentSession(sid);
    }
  });

  it('重新生成:定位回合用户消息,助手兄弟链可来回切换', async () => {
    const sid = await createAgentSession('branch-regen');
    try {
      const u1 = await appendAgentMessage(sid, 'user', '问题一');
      const a1 = await appendAgentMessage(sid, 'assistant', '回答一');
      const u2 = await appendAgentMessage(sid, 'user', '问题二');
      const a2 = await appendAgentMessage(sid, 'assistant', '回答二');

      const source = await getAgentRegenerateSource(sid, a1);
      expect(source).toEqual({ id: u1, content: '问题一' });

      // 模拟重新生成:同一回合的用户消息下追加新的助手链
      const a1b = await appendAgentMessage(sid, 'assistant', '回答一（新）', undefined, u1);
      expect(await contents(sid)).toEqual(['问题一', '回答一（新）']);

      const versions = await getAgentMessageVersions(sid);
      expect(versions[String(a1b)].ids).toEqual([a1, a1b]);
      expect(versions[String(a1b)].index).toBe(1);
      expect(versions[String(a1)].index).toBe(0);
      // 后续回合不在当前可见分支上,不可切换
      expect(await selectAgentMessageVersion(sid, a2)).toBe(false);
      expect(await selectAgentMessageVersion(sid, u2)).toBe(false);

      expect(await selectAgentMessageVersion(sid, a1)).toBe(true);
      expect(await contents(sid)).toEqual(['问题一', '回答一', '问题二', '回答二']);
      expect((await getAgentMessageVersions(sid))[String(a1)].index).toBe(0);
    } finally {
      await deleteAgentSession(sid);
    }
  });

  it('重新生成源只接受最终助手回复:工具调用消息返回 null', async () => {
    const sid = await createAgentSession('branch-tool');
    try {
      const u1 = await appendAgentMessage(sid, 'user', '查一下');
      const call = await appendAgentMessage(
        sid,
        'assistant',
        '{"tool":"search"}',
        { toolCall: { name: 'search', args: { q: '半导体' } } },
        u1,
      );
      const result = await appendAgentMessage(
        sid,
        'user',
        '【工具结果】search: ok',
        { toolResult: { name: 'search', ok: true, content: 'ok' } },
        call,
      );
      const final = await appendAgentMessage(sid, 'assistant', '最终回答', undefined, result);

      expect(await getAgentRegenerateSource(sid, call)).toBeNull();
      expect(await getAgentRegenerateSource(sid, result)).toBeNull();
      expect((await getAgentRegenerateSource(sid, final))?.id).toBe(u1);
      // 会话外的消息 id 不存在
      expect(await getAgentRegenerateSource(sid, 999999)).toBeNull();
    } finally {
      await deleteAgentSession(sid);
    }
  });

  it('压缩后旧根级用户消息不可切回', async () => {
    const sid = await createAgentSession('branch-compact');
    try {
      const u1 = await appendAgentMessage(sid, 'user', '旧问题');
      const a1 = await appendAgentMessage(sid, 'assistant', '旧回答');
      await compactAgentMessages(sid, a1, '（历史对话已压缩）摘要', { contextCompact: true });

      expect(await selectAgentMessageVersion(sid, u1)).toBe(false);
      expect(await contents(sid)).toEqual(['（历史对话已压缩）摘要', '旧回答']);
    } finally {
      await deleteAgentSession(sid);
    }
  });
});
