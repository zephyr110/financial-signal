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

  it('去掉冒号链预警/判断编号，不留残片', () => {
    expect(sanitizeToolSummary('#alert:2026-11-17:market:abc123 [important] 锂价异动'))
      .toBe('[important] 锂价异动');
    expect(sanitizeToolSummary('#j:2026-11-17:industry:9f3c1d [行业] 半导体看多'))
      .toBe('[行业] 半导体看多');
  });
});

describe('sanitizeAnswerText', () => {
  it('抹掉引用编号，保留 markdown 结构', () => {
    const uuid = '3f2c1a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const text = `## 结论\n\n- 财联社 2026-11-17（doc:12）\n- 调查 alert:${uuid} 已完成\n\n信号 #1019 值得关注`;
    expect(sanitizeAnswerText(text))
      .toBe('## 结论\n\n- 财联社 2026-11-17\n- 调查 已完成\n\n信号 值得关注');
  });

  it('保留代码块缩进、嵌套列表与 GFM 表格', () => {
    const code = '```python\ndef f():\n    if True:\n        return 1\n```';
    expect(sanitizeAnswerText(code)).toBe(code);
    expect(sanitizeAnswerText('- 主项\n  - 子项\n    - 孙项'))
      .toBe('- 主项\n  - 子项\n    - 孙项');
    const table = '| | 涨跌幅 | 成交额 |\n| --- | --- | --- |\n| 半导体 | 1.2% | 300亿 |';
    expect(sanitizeAnswerText(table)).toBe(table);
  });

  it('不误删股票代码、颜色、URL 锚点与百分数', () => {
    expect(sanitizeAnswerText('贵州茅台 #600519 今日上涨')).toBe('贵州茅台 #600519 今日上涨');
    expect(sanitizeAnswerText('颜色 #1a2b3c 与 #fff')).toBe('颜色 #1a2b3c 与 #fff');
    expect(sanitizeAnswerText('见 https://e.com/doc#2 第 2 节')).toBe('见 https://e.com/doc#2 第 2 节');
    expect(sanitizeAnswerText('涨幅 #12.5% 居前')).toBe('涨幅 #12.5% 居前');
  });

  it('不把代码或正文里的 alert:high 当引用编号', () => {
    expect(sanitizeAnswerText("{'level':'alert:high','doc':12}"))
      .toBe("{'level':'alert:high','doc':12}");
    expect(sanitizeAnswerText('当前状态为 alert:high，请关注')).toBe('当前状态为 alert:high，请关注');
  });

  it('清理半角空括号', () => {
    expect(sanitizeAnswerText('见 (doc:12) 的公告')).toBe('见 的公告');
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
    expect(sanitizeErrorMessage(undefined)).toBe('任务执行失败，请稍后重试');
  });

  it('URL 后紧跟中文时不吞掉失败原因', () => {
    expect(sanitizeErrorMessage('拉取https://example.com/data失败'))
      .toBe('拉取（接口地址已隐藏）失败');
  });

  it('隐藏无 scheme 的接口主机，但不误伤股票代码', () => {
    expect(sanitizeErrorMessage('getaddrinfo ENOTFOUND api.tushare.pro'))
      .toBe('getaddrinfo ENOTFOUND （接口地址已隐藏）');
    expect(sanitizeErrorMessage('查不到 600519.SH')).toBe('查不到 600519.SH');
  });

  it('支持 JSON 形态的 request_id', () => {
    expect(sanitizeErrorMessage('{"error":{"request_id":"6f1c2b9e"}}'))
      .toBe('{"error":{"}}');
  });
});
