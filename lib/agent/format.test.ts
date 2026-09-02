import { describe, it, expect } from 'vitest';
import {
  extractJson,
  repairJson,
  fixMarkdown,
  detectTruncation,
  formatFinalAnswer,
  stripToolProtocolFromAnswer,
  validateToolArgs,
  looksLikeJson,
  parseJsonLike,
} from './format';

describe('extractJson', () => {
  it('提取纯 JSON 对象', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('剥离 ```json 围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥离前后噪声文本', () => {
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toBe('{"a":1}');
  });

  it('嵌套括号准确定界', () => {
    expect(extractJson('{"tool":"x","args":{"query":"{存储}"}} 结尾')).toBe('{"tool":"x","args":{"query":"{存储}"}}');
  });

  it('支持数组起始结构', () => {
    expect(extractJson('["a", {"b": 1}]')).toBe('["a", {"b": 1}]');
  });

  it('无 JSON 结构返回 null', () => {
    expect(extractJson('这是纯文本回答。')).toBeNull();
  });

  it('未闭合时返回截断候选（交给 repairJson 补全）', () => {
    expect(extractJson('{"a":1,')).toBe('{"a":1,');
  });
});

describe('repairJson', () => {
  it('合法 JSON 原样通过', () => {
    expect(repairJson('{"a":1}')).toBe('{"a":1}');
  });

  it('修复尾逗号', () => {
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
    expect(JSON.parse(repairJson('{"a":1,}') as string)).toEqual({ a: 1 });
  });

  it('修复未加引号的 key', () => {
    const fixed = repairJson('{tool: "search_news", args: {query: "存储"}}');
    expect(JSON.parse(fixed as string)).toEqual({ tool: 'search_news', args: { query: '存储' } });
  });

  it('修复单引号字符串', () => {
    const fixed = repairJson("{'tool': 'search_news'}");
    expect(JSON.parse(fixed as string)).toEqual({ tool: 'search_news' });
  });

  it('修复截断的 JSON（括号补全）', () => {
    const fixed = repairJson('{"tool":"search_news","args":{"query":"存储"');
    expect(JSON.parse(fixed as string)).toEqual({ tool: 'search_news', args: { query: '存储' } });
  });

  it('无法修复（无 JSON 结构）返回 null', () => {
    expect(repairJson('纯文本')).toBeNull();
  });

  it('修复后仍无法解析返回 null（如类型错乱）', () => {
    expect(repairJson('{a: }')).toBeNull();
  });

  it('修复不改写字符串内容（结构正则感知字符串）', () => {
    const fixed = repairJson('{"a": "含,逗号与}大括号", "b": 1,}');
    expect(JSON.parse(fixed as string)).toEqual({ a: '含,逗号与}大括号', b: 1 });
  });

  it('未加引号的 key 修复不碰字符串内部', () => {
    const fixed = repairJson('{"msg": "see, k: 3", foo: 1}');
    expect(JSON.parse(fixed as string)).toEqual({ msg: 'see, k: 3', foo: 1 });
  });

  it('截断于 key 冒号后：补 null 占位', () => {
    const fixed = repairJson('{"tool":"get_industry_heatmap","args":{"hoursBack":');
    expect(JSON.parse(fixed as string)).toEqual({ tool: 'get_industry_heatmap', args: { hoursBack: null } });
  });

  it('截断于对象键引号中间：补 {"":null} 占位', () => {
    const fixed = repairJson('{"tool":"get_industry_heatmap","args":{"');
    expect(JSON.parse(fixed as string)).toEqual({ tool: 'get_industry_heatmap', args: { '': null } });
  });

  it('截断于值字符串中间：补闭合引号', () => {
    const fixed = repairJson('{"a": "未闭合');
    expect(JSON.parse(fixed as string)).toEqual({ a: '未闭合' });
  });
});

describe('looksLikeJson / parseJsonLike', () => {
  it('纯 JSON 判形状', () => {
    expect(looksLikeJson('{"tool":"x"}')).toBe(true);
    expect(looksLikeJson('["a"]')).toBe(true);
  });

  it('围栏包裹的 JSON 判形状', () => {
    expect(looksLikeJson('```json\n{"tool":"x"}\n```')).toBe(true);
  });

  it('散文不判形状（引用 JSON 也不判）', () => {
    expect(looksLikeJson('存储处于发酵阶段。')).toBe(false);
    expect(looksLikeJson('结果如下：{"tool":"x"} 请分析。')).toBe(false);
    expect(looksLikeJson('```js\nconst a = 1;\n```')).toBe(false);
  });

  it('parseJsonLike：围栏剥离后解析', () => {
    expect(parseJsonLike('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLike('这是散文')).toBeNull();
  });
});

describe('fixMarkdown', () => {
  it('未闭合代码块补围栏', () => {
    expect(fixMarkdown('```js\nconst a = 1;')).toBe('```js\nconst a = 1;\n```');
  });

  it('保留硬换行（2+ 尾随空白），只剥单个软换行空白', () => {
    expect(fixMarkdown('标题  \n下一行')).toBe('标题  \n下一行');
    expect(fixMarkdown('标题 \n下一行')).toBe('标题\n下一行');
  });

  it('不清除代码块内的行尾空白', () => {
    expect(fixMarkdown('```js\nconst a = 1;  \n```')).toBe('```js\nconst a = 1;  \n```');
  });

  it('压缩围栏外连续空行，保留围栏内空行', () => {
    expect(fixMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
    expect(fixMarkdown('```text\n第1行\n\n\n\n第5行\n```')).toBe('```text\n第1行\n\n\n\n第5行\n```');
  });

  it('压缩 3+ 连续空行', () => {
    expect(fixMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('剥离非法控制字符', () => {
    expect(fixMarkdown('a\u0000b\u001fc')).toBe('abc');
  });

  it('正常文本原样返回', () => {
    expect(fixMarkdown('**加粗**\n\n- 列表项')).toBe('**加粗**\n\n- 列表项');
  });

  it('空文本返回空', () => {
    expect(fixMarkdown('')).toBe('');
  });
});

describe('detectTruncation', () => {
  it('未闭合代码块判截断', () => {
    expect(detectTruncation('开头\n```python\nx = 1')).toBe(true);
  });

  it('闭合代码块不判截断', () => {
    expect(detectTruncation('```python\nx = 1\n```\n完')).toBe(false);
  });

  it('括号未闭合判截断', () => {
    expect(detectTruncation('这段(内容还没')).toBe(true);
  });

  it('双引号未闭合判截断', () => {
    expect(detectTruncation('他说"你好')).toBe(true);
  });

  it('末尾悬空列表符判截断', () => {
    expect(detectTruncation('要点：\n-')).toBe(true);
  });

  it('正常完整回答不判截断', () => {
    expect(detectTruncation('存储行业近期信号集中在涨价链条。\n\n**结论**：发酵阶段。')).toBe(false);
  });

  it('末尾代码块语言标记判截断', () => {
    expect(detectTruncation('示例：\n```python')).toBe(true);
  });

  it('引用 JSON 的回答不误判截断', () => {
    expect(detectTruncation('模型输出了 {"tool":"get_industry_heatmap","args":{}}，但显示异常。')).toBe(false);
  });

  it('代码块内不平衡括号不误判截断', () => {
    expect(detectTruncation('```js\nif (x) {\n  y();\n}\n```\n完')).toBe(false);
  });

  it('以闭合围栏结尾的完整回答不误判截断', () => {
    expect(detectTruncation('示例：\n```js\nconst a = 1;\n```')).toBe(false);
  });
});

describe('stripToolProtocolFromAnswer', () => {
  it('剥离末行工具 JSON，保留说明文字', () => {
    const raw =
      '让我换个方式，直接搜索存储涨价相关的新闻信号。\n{"tool":"search_news","args":{"query":"存储涨价"}}';
    expect(stripToolProtocolFromAnswer(raw)).toBe('让我换个方式，直接搜索存储涨价相关的新闻信号。');
  });

  it('纯工具 JSON 返回空', () => {
    expect(stripToolProtocolFromAnswer('{"tool":"search_news","args":{"query":"x"}}')).toBe('');
  });

  it('散文内引用 JSON 不剥离', () => {
    const raw = '好的，模型输出了 {"tool":"search_news","args":{"query":"存储"}}，但显示异常。';
    expect(stripToolProtocolFromAnswer(raw)).toBe(raw);
  });
});

describe('formatFinalAnswer', () => {
  it('正常回答：原样修复，不标截断', () => {
    const r = formatFinalAnswer('存储行业近期有 5 条信号，平均分 4.2。');
    expect(r.text).toBe('存储行业近期有 5 条信号，平均分 4.2。');
    expect(r.truncated).toBe(false);
  });

  it('截断回答：修复结构 + 诚实标注', () => {
    const r = formatFinalAnswer('代码如下：\n```js\nconst a = 1');
    expect(r.text).toContain('\n```');
    expect(r.text).toContain('回答因长度限制被截断');
    expect(r.truncated).toBe(true);
  });

  it('空文本返回空', () => {
    expect(formatFinalAnswer('')).toEqual({ text: '', truncated: false });
  });
});

describe('validateToolArgs', () => {
  const tool = {
    name: 'search_news',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        hoursBack: { type: 'number' },
        minScore: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  };

  it('必填缺失报错', () => {
    expect(validateToolArgs(tool, {})).toContain('query');
  });

  it('空串必填报错', () => {
    expect(validateToolArgs(tool, { query: '' })).toContain('query');
  });

  it('明显类型错误报错（对象传给字符串字段）', () => {
    expect(validateToolArgs(tool, { query: { bad: true } })).toContain('query');
  });

  it('数字字符串宽松放行', () => {
    expect(validateToolArgs(tool, { query: '存储', hoursBack: '720' })).toBeNull();
  });

  it('合法参数通过', () => {
    expect(validateToolArgs(tool, { query: '存储', hoursBack: 720 })).toBeNull();
  });

  it('数组传给数字字段报错', () => {
    expect(validateToolArgs(tool, { query: '存储', hoursBack: [720] })).toContain('hoursBack');
  });

  it('非必填字段缺失不报错', () => {
    expect(validateToolArgs(tool, { query: '存储' })).toBeNull();
  });
});
