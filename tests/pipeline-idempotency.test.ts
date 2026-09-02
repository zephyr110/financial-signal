import { describe, it, expect, vi, beforeAll } from 'vitest';

// 用真实内存库（file::memory:）验证 SQL 约束语义——mock execute 无法验证 UNIQUE/ON CONFLICT
vi.hoisted(() => {
  process.env.NEWS_DB_PATH = ':memory:';
});

import {
  getDb,
  insertNewsBatch,
  insertAnalysis,
  saveEventThreads,
  getPipelineCursor,
  setPipelineCursor,
  resetStuckCursor,
  getUnanalyzedNews,
  getEventAnalytics,
  getEventMetrics,
  createAgentSession,
  appendAgentMessage,
  editAgentMessage,
  createAgentShare,
  getSharedSession,
  deleteAgentSession,
} from '../lib/db';
import { runBacktest } from '../lib/market';
import { startPipelineRun, finishPipelineRun, withPipelineRun, getPipelineHealth, isJobFresh } from '../lib/pipeline';

const iso = (offsetH = 0) => new Date(Date.now() - offsetH * 3600 * 1000).toISOString();

beforeAll(async () => {
  await getDb(); // 触发 schema 初始化
});

describe('fetch 幂等（UNIQUE(source, source_id) + INSERT OR IGNORE）', () => {
  it('重复抓取同批数据行数不增长', async () => {
    const db = await getDb();
    const items = [
      { source: 'sina', source_id: 'idem-1', title: 't1', content: 'c1', published_at: iso(), docurl: null },
      { source: 'sina', source_id: 'idem-2', title: 't2', content: 'c2', published_at: iso(), docurl: null },
    ];
    const first = await insertNewsBatch(items);
    const second = await insertNewsBatch(items);
    expect(first).toBe(2);
    expect(second).toBe(0);
    const count = await db.execute({ sql: 'SELECT COUNT(*) as n FROM news_archive WHERE source = ? AND source_id LIKE ?', args: ['sina', 'idem-%'] });
    expect(Number(count.rows[0].n)).toBe(2);
  });
});

describe('analyze 幂等（news_id UNIQUE + ON CONFLICT DO UPDATE）', () => {
  it('重复分析同一条新闻不新增行，内容更新', async () => {
    const db = await getDb();
    await insertNewsBatch([{ source: 'sina', source_id: 'idem-a', title: 'ta', content: 'ca', published_at: iso(), docurl: null }]);
    const row = await db.execute({ sql: 'SELECT id FROM news_archive WHERE source_id = ?', args: ['idem-a'] });
    const newsId = Number(row.rows[0].id);

    const base = {
      news_id: newsId,
      signal_score: 3,
      category: 'industry',
      impact_level: 'significant',
      industries: '["半导体"]',
      companies: null,
      sentiment: 'positive',
      summary: 'v1',
      deep_analysis: null,
      tags: null,
    };
    await insertAnalysis(base);
    await insertAnalysis({ ...base, summary: 'v2', signal_score: 4 });

    const count = await db.execute({ sql: 'SELECT COUNT(*) as n FROM analysis_result WHERE news_id = ?', args: [newsId] });
    expect(Number(count.rows[0].n)).toBe(1);
    const updated = await db.execute({ sql: 'SELECT summary, signal_score FROM analysis_result WHERE news_id = ?', args: [newsId] });
    expect(updated.rows[0].summary).toBe('v2');
    expect(Number(updated.rows[0].signal_score)).toBe(4);
  });
});

describe('event_threads 幂等（dedup_key UNIQUE + ON CONFLICT DO UPDATE）', () => {
  it('同标题线程重复保存不新增行，stage 演进更新', async () => {
    const db = await getDb();
    const signalIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const newsId = 8800 + i;
      await db.execute({
        sql: 'INSERT OR IGNORE INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [newsId, 'test', `thread-news-${i}`, 't', 'c', new Date().toISOString()],
      });
      await db.execute({
        sql: `INSERT OR IGNORE INTO analysis_result (news_id, signal_score, category, impact_level, sentiment, summary)
              VALUES (?, 4, 'industry', 'significant', 'positive', 's')`,
        args: [newsId],
      });
      const row = await db.execute({
        sql: 'SELECT id FROM analysis_result WHERE news_id = ?',
        args: [newsId],
      });
      signalIds.push(Number(row.rows[0].id));
    }
    const thread = (stage: string, confidence: string) => [{
      title: '存储涨价 传导至模组厂',
      news_ids: signalIds,
      narrative: `narrative ${stage}`,
      stage,
      confidence,
      related_industries: ['存储'],
      key_watch_points: ['涨价落地'],
    }];
    await saveEventThreads(thread('early', 'high'));
    await saveEventThreads(thread('brewing', 'medium'));

    const rows = await db.execute("SELECT * FROM event_threads WHERE title LIKE '%存储涨价%'");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].stage).toBe('brewing');
    expect(rows.rows[0].confidence).toBe('medium');

    const links = await db.execute({
      sql: 'SELECT signal_id FROM event_thread_signal WHERE thread_id = ? ORDER BY signal_id',
      args: [rows.rows[0].id],
    });
    expect(links.rows.map((r) => Number(r.signal_id))).toEqual(signalIds.sort((a, b) => a - b));
  });

  it('规范化标题不同（空白差异）视为同一线程', async () => {
    const db = await getDb();
    await saveEventThreads([{ title: '半导体  设备  国产化', news_ids: [9], narrative: 'n', stage: 'early', confidence: 'high', related_industries: [], key_watch_points: [] }]);
    await saveEventThreads([{ title: ' 半导体 设备 国产化 ', news_ids: [9], narrative: 'n2', stage: 'spreading', confidence: 'high', related_industries: [], key_watch_points: [] }]);
    const rows = await db.execute("SELECT * FROM event_threads WHERE dedup_key = '半导体 设备 国产化'");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].stage).toBe('spreading');
  });
});

describe('backtest 幂等（UNIQUE(signal_date, industry) + INSERT OR REPLACE）', () => {
  it('重复运行行数不变，行业别名兜底生效', async () => {
    const db = await getDb();
    const newsId = 9001;
    const today = new Date().toISOString().slice(0, 10);
    await db.execute({
      sql: 'INSERT OR IGNORE INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [newsId, 'test', 'idem-bt', 'bt news', 'c', new Date().toISOString()],
    });
    await db.execute({
      sql: `INSERT OR IGNORE INTO analysis_result (news_id, signal_score, category, impact_level, industries, companies, sentiment, summary)
            VALUES (?, 4, 'industry', 'significant', ?, NULL, 'positive', 'bt')`,
      args: [newsId, JSON.stringify(['半导体'])],
    });
    // 后续 7 个交易日的板块行情（signal_date 之后）
    const values = Array.from({ length: 7 }, (_, i) => `(?, ?, ?, ?, ?)`).join(', ');
    const args = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10);
      return ['BK1325', '半导体材料', 'index', d, 1.0 + i * 0.1];
    }).flat();
    await db.execute({
      sql: `INSERT OR REPLACE INTO market_data (code, name, type, trade_date, change_pct)
            VALUES ${values}`,
      args,
    });
    void today;

    await runBacktest(30);
    const first = await db.execute('SELECT COUNT(*) as n FROM backtest_result');
    const before = Number(first.rows[0].n);
    await runBacktest(30);
    const second = await db.execute('SELECT COUNT(*) as n FROM backtest_result');
    expect(Number(second.rows[0].n)).toBe(before);

    // 别名映射生效：'半导体' → '半导体材料'，day_1_return 非空
    const row = await db.execute("SELECT industry, day_1_return FROM backtest_result WHERE industry = '半导体'");
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].day_1_return).not.toBeNull();
  });
});

describe('批处理游标（P1.3）', () => {
  it('set/getPipelineCursor 单调推进', async () => {
    await setPipelineCursor('analyze', 42);
    expect(await getPipelineCursor('analyze')).toBe(42);
    await setPipelineCursor('analyze', 43);
    expect(await getPipelineCursor('analyze')).toBe(43);
  });

  it('getUnanalyzedNews 按发布时间倒序（新新闻优先），90 天前旧数据被过滤', async () => {
    const db = await getDb();
    const now = Date.now();
    // 4 条未分析新闻，published_at 递增（9600 最旧 → 9603 最新）
    for (let i = 0; i < 4; i++) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [9600 + i, 'test', `new-${i}`, `t${i}`, `c${i}`, new Date(now - (3 - i) * 60_000).toISOString()],
      });
    }
    // 95 天前的旧新闻应被 90 天窗口过滤
    await db.execute({
      sql: 'INSERT OR IGNORE INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [9604, 'test', 'old', 'old', 'old', new Date(now - 95 * 24 * 3600_000).toISOString()],
    });
    const rows = await getUnanalyzedNews(50);
    // 同 DB 可能有其他测试插入的未分析新闻，只断言本用例的 9600-9604 子集
    const mine = rows.filter((r) => Number(r.id) >= 9600 && Number(r.id) <= 9604);
    expect(mine.map((r) => Number(r.id))).toEqual([9603, 9602, 9601, 9600]); // 最新优先
    expect(mine.some((r) => Number(r.id) === 9604)).toBe(false); // 90 天前被过滤
  });

  it('resetStuckCursor：游标前残留超阈值则重置为 0', async () => {
    const db = await getDb();
    // 21 条未分析新闻全部位于游标之前（id 9500-9520）
    for (let i = 0; i < 21; i++) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO news_archive (id, source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [9500 + i, 'test', `stuck-${i}`, `t${i}`, `c${i}`, new Date().toISOString()],
      });
    }
    await setPipelineCursor('deep-analyze', 9520);
    const c = await resetStuckCursor('deep-analyze', 9520);
    expect(c).toBe(0);
    expect(await getPipelineCursor('deep-analyze')).toBe(0);
  });

  it('resetStuckCursor：残留未超阈值不重置游标', async () => {
    await setPipelineCursor('analyze', 0);
    // 残留仅 6 条（≤ 阈值 20）→ 返回原游标且不写库（游标保持 0）
    const c = await resetStuckCursor('analyze', 9300);
    expect(c).toBe(9300);
    expect(await getPipelineCursor('analyze')).toBe(0);
  });
});

describe('P2.1 埋点按日聚合', () => {
  it('getEventAnalytics 按日/事件分组，独立 session 去重', async () => {
    const db = await getDb();
    const day = new Date().toISOString().slice(0, 10);
    const payload = (session: string, extra = {}) =>
      JSON.stringify({ ts: new Date().toISOString(), session, ...extra });
    // 同 session 两条 signal_click + 一条 thread_expand；另一 session 一条 search_query
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
      args: ['signal_click', 101, payload('sess-a', { id: 101 })],
    });
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
      args: ['signal_click', 102, payload('sess-a', { id: 102 })],
    });
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
      args: ['thread_expand', 7, payload('sess-a', { id: 7 })],
    });
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
      args: ['search_query', null, payload('sess-b', { query: '半导体' })],
    });

    const rows = await getEventAnalytics(7);
    const sig = rows.find((r) => r.event_type === 'signal_click' && r.day === day);
    const thr = rows.find((r) => r.event_type === 'thread_expand' && r.day === day);
    const search = rows.find((r) => r.event_type === 'search_query' && r.day === day);
    expect(sig).toBeDefined();
    expect(sig.count).toBe(2);
    expect(sig.sessions).toBe(1); // 同 session 去重
    expect(thr.count).toBe(1);
    expect(search.count).toBe(1);
    expect(search.sessions).toBe(1);
  });

  it('getEventMetrics：跨窗口周回访聚合（SQL 别名 returning 回归）', async () => {
    const db = await getDb();
    // 隔离：清掉上一个用例（getEventAnalytics）插入的会话，避免污染 7 天窗口计数
    await db.execute({ sql: 'DELETE FROM event_log' });
    const day = 24 * 60 * 60 * 1000;
    const payload = (session: string) => JSON.stringify({ ts: new Date().toISOString(), session });
    // 最近 7 天窗口：sess-x（3 天前）、sess-z（1 天前）
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?)',
      args: ['signal_click', 1, payload('sess-x'), new Date(Date.now() - 3 * day).toISOString()],
    });
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?)',
      args: ['signal_click', 2, payload('sess-z'), new Date(Date.now() - 1 * day).toISOString()],
    });
    // 前 7 天窗口：sess-x 再次出现（应计入周回访），sess-y 仅老窗口
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?)',
      args: ['thread_expand', 3, payload('sess-x'), new Date(Date.now() - 10 * day).toISOString()],
    });
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload, created_at) VALUES (?, ?, ?, ?)',
      args: ['thread_expand', 4, payload('sess-y'), new Date(Date.now() - 12 * day).toISOString()],
    });

    const m = await getEventMetrics(7);
    expect(m.uniqueSessions).toBe(2);
    expect(m.weeklyReturn.recentSessions).toBe(2);
    expect(m.weeklyReturn.returning).toBe(1);
  });
});

describe('agent 会话分享（公开只读链接）', () => {
  it('createAgentShare 幂等：同一会话复用 token，token 唯一且非空', async () => {
    const sid = await createAgentSession('分享测试');
    await appendAgentMessage(sid, 'user', '你好');
    await appendAgentMessage(sid, 'assistant', '**回复**');

    const t1 = await createAgentShare(sid);
    const t2 = await createAgentShare(sid);
    expect(t1).toBeTruthy();
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[0-9a-f]{32}$/); // randomUUID 去连字符

    const shared = await getSharedSession(t1);
    expect(shared).not.toBeNull();
    expect(shared!.title).toBe('分享测试');
    expect(shared!.messages.length).toBe(2);
    expect(shared!.messages[0].content).toBe('你好');
  });

  it('编辑重发：替换内容并截断其后消息；跨会话/不存在返回 false', async () => {
    const db = await getDb();
    const sid = await createAgentSession('编辑测试');
    const m1 = await appendAgentMessage(sid, 'user', '旧问题');
    const m2 = await appendAgentMessage(sid, 'assistant', '旧回答');
    await appendAgentMessage(sid, 'assistant', '后续内容');

    const ok = await editAgentMessage(sid, m1, '新问题');
    expect(ok).toBe(true);
    const rows = await db.execute({ sql: 'SELECT id, content FROM agent_message WHERE session_id = ? ORDER BY id ASC', args: [sid] });
    expect(rows.rows.length).toBe(1); // 编辑消息后的全部消息被截断
    expect(rows.rows[0].content).toBe('新问题');

    expect(await editAgentMessage(sid, 99999, '不存在')).toBe(false);
    const sid2 = await createAgentSession('另一会话');
    expect(await editAgentMessage(sid2, m1, '越权编辑')).toBe(false);
  });

  it('无效 token → null；删除会话后分享链接失效', async () => {
    expect(await getSharedSession('nonexistent-token')).toBeNull();

    const sid = await createAgentSession('待删除分享');
    const token = await createAgentShare(sid);
    await deleteAgentSession(sid);
    expect(await getSharedSession(token)).toBeNull();
  });
});

describe('pipeline_run 状态机', () => {
  it('同批次重复启动 retry_count 递增', async () => {
    const db = await getDb();
    const r1 = await startPipelineRun('fetch', 'batch-retry');
    const r2 = await startPipelineRun('fetch', 'batch-retry');
    expect(r2).toBeGreaterThan(r1);
    const rows = await db.execute({ sql: 'SELECT retry_count FROM pipeline_run WHERE id = ?', args: [r2] });
    expect(Number(rows.rows[0].retry_count)).toBe(1);
  });

  it('withPipelineRun 成功记录 status/items，失败记录 error', async () => {
    const ok = await withPipelineRun('analyze', 'batch-ok', async () => ({ analyzed: 3 }), (r) => r.analyzed);
    expect(ok).toEqual({ analyzed: 3 });
    await expect(
      withPipelineRun('fetch-market', 'batch-fail', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    const db = await getDb();
    const okRow = await db.execute("SELECT status, items_processed FROM pipeline_run WHERE batch_id = 'batch-ok'");
    expect(okRow.rows[0].status).toBe('success');
    expect(Number(okRow.rows[0].items_processed)).toBe(3);
    const failRow = await db.execute("SELECT status, error FROM pipeline_run WHERE batch_id = 'batch-fail'");
    expect(failRow.rows[0].status).toBe('failed');
    expect(failRow.rows[0].error).toContain('boom');
  });

  it('isJobFresh：无成功记录 → false（放行）', async () => {
    expect(await isJobFresh('fetch', 6 * 3600 * 1000)).toBe(false);
  });

  it('isJobFresh：距上次成功 < 间隔 → true（跳过）', async () => {
    const r = await startPipelineRun('fetch', 'fresh-a');
    await finishPipelineRun(r, { ok: true, items: 1 });
    expect(await isJobFresh('fetch', 6 * 3600 * 1000)).toBe(true);
  });

  it('isJobFresh：距上次成功 ≥ 间隔 → false（放行）', async () => {
    const r = await startPipelineRun('fetch', 'fresh-b');
    await finishPipelineRun(r, { ok: true, items: 1 });
    const db = await getDb();
    // 回拨本用例与 fresh-a 两条成功记录的 finished_at 到 7 小时前（间隔 6h），
    // 避免 fresh-a 的最近成功覆盖本用例的判定
    await db.execute({
      sql: 'UPDATE pipeline_run SET finished_at = ? WHERE job_name = ? AND status = ? AND batch_id IN (?, ?)',
      args: [iso(7), 'fetch', 'success', 'fresh-a', 'fresh-b'],
    });
    expect(await isJobFresh('fetch', 6 * 3600 * 1000)).toBe(false);
  });

  it('isJobFresh：仅最近一次失败 → false（放行）', async () => {
    const r = await startPipelineRun('fetch', 'fresh-c');
    await finishPipelineRun(r, { ok: false, error: 'boom' });
    expect(await isJobFresh('fetch', 6 * 3600 * 1000)).toBe(false);
  });

  it('getPipelineHealth 聚合成功率/耗时/错误', async () => {
    // 构造可控三态：1 success + 1 failed + 1 running（用独立 job 名隔离其他测试的记录）
    const r1 = await startPipelineRun('event-threads', 'health-a');
    await finishPipelineRun(r1, { ok: true, items: 5 });
    const r2 = await startPipelineRun('event-threads', 'health-b');
    await finishPipelineRun(r2, { ok: false, error: 'market timeout' });
    await startPipelineRun('event-threads', 'health-c'); // 故意不 finish → running

    const health = await getPipelineHealth(24);
    const fm = health.jobs.find((j) => j.job_name === 'event-threads');
    expect(fm.runs).toBe(3);
    expect(fm.successes).toBe(1);
    expect(fm.failures).toBe(1);
    expect(fm.success_rate).toBe(33.3);
    expect(fm.last_error).toContain('market timeout');
    expect(fm.avg_duration_s).toBeTypeOf('number');
    expect(health.total.runs).toBeGreaterThanOrEqual(3);
  });
});
