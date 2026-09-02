/**
 * 研究 Agent — 输出质量保障层（确定性格式化引擎）
 *
 * 架构定位：与 tools.ts 中注册的 LLM 格式化工具（format_markdown / fix_json）构成双层防线：
 *
 *   1. 本模块 = 确定性管道：零 LLM 成本、必执行、可单测。
 *      - 出口：runAgentTurn 最终回答（formatFinalAnswer：截断检测 → markdown 修复 → 诚实标注）
 *      - 中间调度：工具调用 JSON 的后校正（extractJson + repairJson，挂在 tryParseToolCall）
 *      - 前校验：validateToolArgs（挂在工具执行前，参数非法直接回喂模型重试）
 *   2. LLM 工具 = 模型主动侧入口：整理草稿、修复外部损坏 JSON。
 *
 * 修复原则：只做结构层面可验证的修复（围栏配对、括号配对、JSON 语法级修复），
 * 不做内容层面的猜测改写，避免误伤正常输出。
 */

/** 从任意文本中提取第一个完整 JSON 结构（{…} 或 […]），括号配对准确定界。
 *  剥离开头噪声与 ```json 围栏；未闭合时返回从起始到末尾的截断候选（交给 repairJson 补全）。 */
export function extractJson(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : trimmed).trim();
  const startIdx = candidate.search(/[[{]/);
  if (startIdx === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return candidate.slice(startIdx, i + 1);
    }
  }
  return candidate.slice(startIdx); // 未闭合：截断候选
}

/** 判断文本是否为"工具调用形状"：纯 JSON 或以 ```json 围栏包裹的 JSON。
 *  工具协议要求调用是"严格 JSON（不要输出其他文字）"，因此只有 JSON 形状的输出
 *  才进入修复/重试路径——散文回答里引用 {"tool":...} 不会被误执行或误判格式错误。 */
export function looksLikeJson(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const target = (fence ? fence[1] : trimmed).trim();
  return /^[[{]/.test(target);
}

/** 尝试直接解析（剥离 ```json 围栏后）；失败返回 null。 */
export function parseJsonLike(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence ? fence[1].trim() : null, trimmed].filter(Boolean) as string[];
  for (const raw of candidates) {
    try {
      return JSON.parse(raw);
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 把指定引号类型的字符串字面量替换为 \u0000n\u0000（双引号）/ \u0001n\u0001（单引号）占位符。
 *  结构修复正则只作用于占位符之间的分隔符/键名，绝不改写字符串内容；两种占位符互不串扰。 */
function protectStrings(x: string, quote: '"' | "'"): { text: string; strings: string[] } {
  const marker = quote === '"' ? '\u0000' : '\u0001';
  const strings: string[] = [];
  let out = '';
  let i = 0;
  while (i < x.length) {
    if (x[i] === quote) {
      let j = i + 1;
      let escaped = false;
      for (; j < x.length; j++) {
        const c = x[j];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (c === '\\') {
          escaped = true;
          continue;
        }
        if (c === quote) {
          j++;
          break;
        }
      }
      strings.push(x.slice(i, j));
      out += `${marker}${strings.length - 1}${marker}`;
      i = j;
    } else {
      out += x[i++];
    }
  }
  return { text: out, strings };
}

/** 逐级修复损坏的 JSON：尾逗号 → 未加引号的 key → 单引号字符串 → 截断补全。
 *  结构修复全程保护字符串内容（protectStrings 占位），每级修复后立即尝试解析，
 *  成功即返回；全部失败返回 null。 */
export function repairJson(raw: string): string | null {
  if (!raw) return null;
  const s = extractJson(raw) ?? raw.trim();
  if (!s) return null;

  const tryParse = (x: string): boolean => {
    try {
      JSON.parse(x);
      return true;
    } catch {
      return false;
    }
  };
  if (tryParse(s)) return s;

  // 先保护双引号字符串，再保护单引号字符串（双引号转占位后，单引号正则不再误配对）
  const protD = protectStrings(s, '"');
  const protS = protectStrings(protD.text, "'");
  const restoreD = (t: string) => t.replace(/\u0000(\d+)\u0000/g, (_, n) => protD.strings[Number(n)]);
  const restoreS = (t: string) => t.replace(/\u0001(\d+)\u0001/g, (_, n) => protS.strings[Number(n)]);
  const restoreAll = (t: string) => restoreD(restoreS(t));

  // 修复级数从轻到重（运行于占位文本：只动结构，不碰字符串内容）
  const passes: Array<(x: string) => string> = [
    // 1. 尾逗号（对象/数组结尾的悬空逗号）
    (x) => x.replace(/,\s*([}\]])/g, '$1'),
    // 2. 未加引号的 key：{a: 1, "b": 2} → {"a": 1, "b": 2}
    (x) => x.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3'),
  ];

  let current = protS.text;
  for (const pass of passes) {
    const next = pass(current);
    if (next === current) continue;
    current = next;
    const restored = restoreAll(current);
    if (tryParse(restored)) return restored;
  }

  // 3. 单引号字符串 → 双引号（双引号字符串此时仍被保护，转换不会误伤其内容）
  const withSingle = restoreS(current);
  const converted = withSingle.replace(/'([^'\\\n]|\\.)*'/g, (m) => m.replace(/'/g, '"'));
  if (converted !== withSingle) {
    const restored = restoreD(converted);
    if (tryParse(restored)) return restored;
  }

  // 4. 截断补全：未闭合字符串补引号、期待值处补 null 占位、括号按序补齐
  const closed = closeBrackets(restoreD(converted));
  if (closed !== s && tryParse(closed)) return closed;

  return null;
}

/** 按括号配对补齐缺失的闭合符（忽略字符串内的括号）。
 *  顺带补两处截断形态：未闭合字符串补闭合引号（值位置直接闭合、键位置补 {"":null} 占位）、
 *  刚写完 key（:）或数组逗号后补 null 占位。 */
function closeBrackets(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let expectingValue = false; // 刚写完 key（:）或数组逗号后 → 补值时需要占位
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        expectingValue = false; // 字符串本身即值
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      expectingValue = ch === '['; // 对象内期待键，数组内期待值
      continue;
    }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) return s; // 错配，不强行修复
      expectingValue = false;
      continue;
    }
    if (ch === ':') {
      expectingValue = true;
      continue;
    }
    if (ch === ',') {
      expectingValue = stack[stack.length - 1] === '[';
      continue;
    }
    if (!/\s/.test(ch)) expectingValue = false; // 值字符
  }
  const tail: string[] = [];
  if (inStr) {
    tail.push(expectingValue ? '"' : '":null'); // 截断于字符串中间：补闭合引号（键位置补键值占位）
  } else if (expectingValue) {
    tail.push('null'); // 刚写完 key 或数组逗号，期待一个值
  }
  if (stack.length > 0) tail.push(...stack.reverse().map((o) => (o === '{' ? '}' : ']')));
  if (tail.length === 0) return s;
  return s + tail.join('');
}

/** 修复常见 Markdown 语法问题（结构层面，不改写内容）：
 *  未闭合代码块围栏补全、行尾空白处理（保留硬换行）、多余空行压缩、非法控制字符剥离。
 *  行级处理感知代码块围栏：围栏内的行尾空白与空行是内容，一律不碰。 */
export function fixMarkdown(text: string): string {
  if (!text) return text;
  let s = text;
  // 1. 代码块围栏配对（行首 ``` 计数为奇数 → 末尾补围栏）
  const fences = (s.match(/^```/gm) || []).length;
  if (fences % 2 === 1) s = s.trimEnd() + '\n```';

  // 2. 行级修复（感知围栏）：行尾空白与连续空行只在围栏外处理
  let inFence = false;
  let prevEmpty = false; // 围栏外同一段连续空行只保留 1 行（等价于 3+ 空行 → 2 换行）
  const out: string[] = [];
  for (const line of s.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      prevEmpty = false;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line); // 代码块内容原样保留
      prevEmpty = false;
      continue;
    }
    // 行尾空白：单个尾随空白是软换行，可安全剥离；两个及以上是硬换行（<br>），保留
    const m = line.match(/[ \t]+$/);
    const cleaned = m && m[0].length === 1 ? line.slice(0, -1) : line;
    if (/^[ \t]*$/.test(cleaned)) {
      if (prevEmpty) continue;
      prevEmpty = true;
      out.push(cleaned);
      continue;
    }
    prevEmpty = false;
    out.push(cleaned);
  }
  s = out.join('\n');

  // 3. 剥离 BOM 与非法控制字符（保留 \t \n \r）
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.trim();
}

/** 检测内容是否被截断：只认结构性信号（未闭合代码块/括号/引号、行尾悬空列表或表格符）。
 *  计数跳过字符串内与闭合代码块内的内容——回答里引用 JSON 或代码片段不会误判为截断。 */
export function detectTruncation(text: string): boolean {
  if (!text) return false;
  // 1. 代码块围栏未闭合（奇数个 ```）
  if ((text.match(/^```/gm) || []).length % 2 === 1) return true;

  // 2. 成对符号与双引号配对：跳过字符串内与闭合代码块内（围栏成对说明内容完整）
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  let inStr = false;
  let esc = false;
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (const ch of stripped) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch in counts) counts[ch]++;
  }
  if (inStr) return true; // 以未闭合双引号结尾 → 截断（未闭合必为奇数开引号，奇偶检查冗余）
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    if (counts[open] > counts[close]) return true;
  }

  // 3. 末尾是半截结构：悬空列表符 / 表格分隔符（代码块语言标记由规则 1 的奇数围栏覆盖）
  const lastLine = text.trimEnd().split('\n').pop() ?? '';
  if (/^[-*+]\s*$/.test(lastLine)) return true;
  if (/^\d+[.)]\s*$/.test(lastLine)) return true;
  if (/^\|[\s|]*$/.test(lastLine)) return true;
  return false;
}

/** 判断文本是否为工具协议 JSON（含 tool 字段） */
function isToolProtocolJson(text: string): boolean {
  const parsed = parseJsonLike((text || '').trim());
  return !!(parsed && typeof parsed === 'object' && typeof (parsed as { tool?: unknown }).tool === 'string');
}

/** 从用户可见回答中剥离工具协议 JSON（纯 JSON、末行 JSON、末尾围栏块） */
export function stripToolProtocolFromAnswer(text: string): string {
  if (!text) return '';
  let s = text.trimEnd();

  const fenceRe = /\n?```(?:json)?\s*\n[\s\S]*?"tool"\s*:[\s\S]*?\n```\s*$/;
  const fenceMatch = s.match(fenceRe);
  if (fenceMatch) {
    const inner = fenceMatch[0].replace(/^[\s\S]*?\n/, '').replace(/\n```\s*$/, '');
    if (isToolProtocolJson(inner)) {
      s = s.slice(0, s.length - fenceMatch[0].length).trimEnd();
    }
  }

  const lines = s.split('\n');
  if (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    // 完整或生成中的末行工具 JSON
    if (
      (looksLikeJson(last) && isToolProtocolJson(last)) ||
      (/^[\[{`"]/.test(last) && /"tool"/.test(last))
    ) {
      s = lines.slice(0, -1).join('\n').trimEnd();
    }
  }

  if (looksLikeJson(s.trim()) && isToolProtocolJson(s.trim())) {
    return '';
  }

  return s;
}

/** 最终回答出口管道：截断检测 → markdown 修复 → 截断时诚实标注。
 *  结构截断（围栏/括号）由 fixMarkdown 修复；内容半截无法恢复时追加提示行。 */
export function formatFinalAnswer(text: string): { text: string; truncated: boolean } {
  const t = (text ?? '').trim();
  if (!t) return { text: '', truncated: false };
  const truncated = detectTruncation(t);
  const fixed = fixMarkdown(t);
  if (truncated) {
    return {
      text: fixed + '\n\n> ⚠️ 回答因长度限制被截断，如需完整内容可追问。',
      truncated: true,
    };
  }
  return { text: fixed, truncated: false };
}

/** 工具调用参数前校验（宽松策略）：必填缺失与明显类型错误才拦截，
 *  可无损转换的值（如数字字符串）放行——目的是防无效调用，不是拒绝合法参数。 */
export function validateToolArgs(
  tool: { name: string; parameters: Record<string, unknown> },
  args: Record<string, unknown>
): string | null {
  const schema = tool.parameters as { required?: string[]; properties?: Record<string, { type?: string }> };
  const required = schema.required ?? [];
  const properties = schema.properties ?? {};

  for (const key of required) {
    const v = args[key];
    if (v === undefined || v === null || v === '') {
      return `缺少必填参数 "${key}"`;
    }
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const type = properties[key]?.type;
    if (!type) continue;
    if (type === 'string') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return `参数 "${key}" 应为字符串，实际为 ${Array.isArray(value) ? '数组' : typeof value}`;
      }
    } else if (type === 'number' || type === 'integer') {
      const ok = typeof value === 'number'
        || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
      if (typeof value === 'boolean' || !ok) {
        return `参数 "${key}" 应为数字，实际为 ${typeof value}`;
      }
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean' && !['true', 'false'].includes(String(value))) {
        return `参数 "${key}" 应为布尔值，实际为 ${typeof value}`;
      }
    }
  }
  return null;
}
