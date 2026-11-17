import { describe, it, expect } from 'vitest';
import { displayToolArgs, sanitizeAnswerText, sanitizeErrorMessage, sanitizeToolSummary } from './safe-json';

describe('displayToolArgs', () => {
  it('隐藏内部编号的值，保留查询意图与普通参数', () => {
    const text = displayToolArgs({
      signalId: 1019,
      alertId: 'a1',
      payload: { eventId: 7, title: '国产算力' },
      query: '半导体',
      valid: true,
    });
    expect(text).toContain('"signalId": "…"');
    expect(text).toContain('"alertId": "…"');
    expect(text).toContain('"eventId": "…"');
    expect(text).toContain('"title": "国产算力"');
    expect(text).toContain('"query": "半导体"');
    expect(text).toContain('"valid": true');
    expect(text).not.toContain('1019');
    expect(text).not.toContain('"a1"');
  });
});

describe('sanitizeToolSummary', () => {
  it('去掉信号/预警的 # 编号', () => {
    expect(sanitizeToolSummary('#1019 4分/行业｜2026-11-17')).toBe('4分/行业｜2026-11-17');
    expect(sanitizeToolSummary('事件线索 #7: 国产算力')).toBe('事件线索：国产算力');
  });

  it('去掉 UUID 与关联编号', () => {
    const uuid = '3f2c1a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    expect(sanitizeToolSummary(`调查 ${uuid}｜succeeded｜进度 100%`))
      .toBe('调查｜succeeded｜进度 100%');
    expect(sanitizeToolSummary(`已创建待确认动作 ${uuid}（create_task，状态 proposed）。`))
      .toBe('已创建待确认动作（create_task，状态 proposed）。');
  });

  it('保留正文与换行，只清理内部编号', () => {
    expect(sanitizeToolSummary('找到 8 条相关信号：\n- #12 摘要')).toBe('找到 8 条相关信号：\n- 摘要');
  });

  it('去掉证据引用号与带编号的内部标识', () => {
    expect(sanitizeToolSummary('doc:12｜2026-11-17｜标题')).toBe('2026-11-17｜标题');
    expect(sanitizeToolSummary('industry:半导体:2026-11-14 均值 1.2%')).toBe('均值 1.2%');
    expect(sanitizeToolSummary('引用信号ID 1019 与事件线索ID 7')).toBe('引用信号 与事件线索');
  });
});

describe('sanitizeAnswerText', () => {
  it('抹掉引用编号，保留 markdown 结构', () => {
    const uuid = '3f2c1a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const text = `## 结论\n\n- 财联社 2026-11-17（doc:12）\n- 调查 alert:${uuid} 已完成\n\n信号 #1019 值得关注`;
    expect(sanitizeAnswerText(text))
      .toBe('## 结论\n\n- 财联社 2026-11-17\n- 调查 已完成\n\n信号 值得关注');
  });
});

describe('sanitizeErrorMessage', () => {
  it('隐藏接口地址、厂牌与请求 ID', () => {
    const text = sanitizeErrorMessage(
      'LLM API 500: connect ECONNREFUSED https://api.deepseek.com/v1/chat/completions request_id=abc-123',
    );
    expect(text).not.toContain('deepseek');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('abc-123');
    expect(text).toContain('LLM API 500');
  });

  it('保留可操作的中文失败原因', () => {
    expect(sanitizeErrorMessage('Tushare 接口返回 40203: 积分不足'))
      .toBe('Tushare 接口返回 40203: 积分不足');
  });

  it('空文本给出兜底文案', () => {
    expect(sanitizeErrorMessage('   ')).toBe('任务执行失败，请稍后重试');
  });
});
