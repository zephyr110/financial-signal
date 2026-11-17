/** 对外输出 JSON 前剥掉模型名、请求/会话 ID 等内部字段（设置弹窗除外）。 */
const INTERNAL_JSON_KEYS = new Set([
  'model', 'narrativeModel', 'requestId', 'request_id', 'traceId', 'trace_id',
  'sessionId', 'session_id', 'taskId', 'task_id', 'messageId', 'message_id', 'turnId', 'turn_id',
  'investigationId', 'investigation_id', 'alertId', 'alert_id', 'refId', 'ref_id',
  'eventId', 'event_id', 'signalId', 'signal_id', 'projectId', 'project_id',
  'documentId', 'document_id', 'docId', 'doc_id', 'tokensUsed', 'tokens_used',
  'costMicros', 'cost_micros',
  'apiKey', 'api_key', 'token', 'secret', 'password',
]);

export function publicJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (INTERNAL_JSON_KEYS.has(key) ? undefined : v)) ?? 'null';
}

/** 工具参数面板展示用：保留键名以看出查询意图，内部编号的值替换为省略号。 */
const ID_ARG_KEY = /^id$|_id$|(?:^|[a-z0-9])I[dD]$/;

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 取值必须含数字才算引用编号，避免把 alert:high 这类正文或 JSON 值当编号删掉。
const REF_CODE_PATTERN = /(^|[^\w/])(?:alert-evidence|doc|document|alert|judgment|industry|signal|project|memory|overseas):(?=[A-Za-z0-9_:\-一-鿿]*\d)[A-Za-z0-9_:\-一-鿿]+/g;
const LABELED_ID_PATTERN = /(信号|事件线索|文档|调查|任务|请求|会话|预警|判断)\s*(?:ID|id|Id)\s*[:：=]?\s*#?[A-Za-z0-9_-]+/g;

export function displayToolArgs(args: unknown): string {
  return JSON.stringify(args, (key, value) => (ID_ARG_KEY.test(key) ? '…' : value), 2) ?? 'null';
}

// 错误信息里的文件名/源码位置不是主机名：db-config.json、analysis.tsx:42 必须原样保留。
// 故意不收 md/py/zip/sh/local：它们同时是真实顶级域名，放进来会让主机名漏过脱敏。
const FILE_EXTENSIONS = new Set([
  'json', 'jsonl', 'tsx', 'ts', 'jsx', 'js', 'mjs', 'cjs', 'db', 'sqlite', 'sqlite3', 'sql',
  'log', 'txt', 'css', 'html', 'htm', 'yaml', 'yml', 'toml', 'ini', 'env',
  'lock', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'csv', 'xlsx', 'xls',
  'gz', 'tar', 'pem', 'key', 'crt', 'map', 'wasm', 'node', 'gitkeep',
]);

const CURRENCY_CODES = new Set([
  'USD', 'CNY', 'EUR', 'JPY', 'HKD', 'GBP', 'AUD', 'CAD', 'CHF', 'SGD', 'KRW', 'TWD', 'MOP',
]);

/**
 * 任务失败文案会进任务中心与站内通知：去掉接口地址、请求 ID 与模型厂牌，
 * 只留下用户能据此行动的原因。
 */
export function sanitizeErrorMessage(text: string | null | undefined): string {
  return String(text ?? '')
    // 任意 scheme（https/libsql/ws/file…）都算接口地址；停止在中文与标点前，
    // 否则「https://x/失败」会把失败原因一起吞掉。
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s一-鿿，。；、）)（("'<>]*/gi, '（接口地址已隐藏）')
    // 主机名不写死 TLD 白名单；文件名后缀、股票代码、异常类名与汇率对不是主机名。
    .replace(
      /(^|[^\w/.\-])([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.([a-z]{2,})(?::\d+)?(?:\/[^\s一-鿿，。；、）)（("'<>]*)?/gi,
      (match, prefix: string, labels: string, tld: string) => {
        const upperTld = tld.toUpperCase();
        // 带点的 labels 是主机名（api.example.json），不当成文件名放行。
        const isFile = !labels.includes('.') && FILE_EXTENSIONS.has(tld.toLowerCase());
        const isStock = (/^\d{6}$/.test(labels) && /^(?:SH|SZ|BJ)$/i.test(tld))
          || (/^\d{5}$/.test(labels) && /^HK$/i.test(tld));
        const isExceptionClass = /(?:Error|Exception)$/.test(tld);
        const isCurrencyPair = CURRENCY_CODES.has(labels.toUpperCase()) && CURRENCY_CODES.has(upperTld);
        return isFile || isStock || isExceptionClass || isCurrencyPair
          ? match
          : `${prefix}（接口地址已隐藏）`;
      },
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '（接口地址已隐藏）')
    .replace(/\b(?:deepseek|openai|anthropic|qwen|claude|gemini|llama)[\w.-]*/gi, '模型服务')
    .replace(/\brequest[ _-]?id\b["']?\s*[:=]\s*["']?[A-Za-z0-9_-]+["']?/gi, '')
    .replace(UUID_PATTERN, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim() || '任务执行失败，请稍后重试';
}

/** 工具摘要展示用：去掉 #123、UUID 等内部编号，这些对读者没有意义。 */
export function sanitizeToolSummary(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        // 预警/判断 id 是 alert:日期:类别:哈希 这样的冒号链，必须整段吃掉；
        // 但 6 位股票代码（#600519 / #600519.SH）要留给读者。
        .replace(/#(?!\d{6}(?:\.[A-Za-z]{2})?(?![\w-]))[\w-]+(?::[\w.:-]+)*/g, '')
        .replace(REF_CODE_PATTERN, '$1')
        .replace(UUID_PATTERN, '')
        .replace(/^[｜|]+/, '')
        .replace(LABELED_ID_PATTERN, '$1')
        .replace(/\s+[:：]\s*/g, '：')
        .replace(/[ \t]+([，。；、）｜（])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .trim(),
    )
    .join('\n');
}

/**
 * 助手正文渲染用：只抹掉引用编号与 UUID，不改动空白和 markdown 排版。
 * 提示词已要求不引用内部编号，这里兜住模型偶尔的复述。
 */
export function sanitizeAnswerText(text: string): string {
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^[ \t]*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      // 代码块里的缩进就是语义，整段不碰。
      if (inFence || !line.trim()) return line;
      const lead = line.match(/^[ \t]*/)?.[0] ?? '';
      const trail = line.match(/[ \t]+$/)?.[0] ?? '';
      const body = line.slice(lead.length, line.length - trail.length);
      const cleaned = body
        .replace(REF_CODE_PATTERN, '$1')
        .replace(UUID_PATTERN, '')
        .replace(LABELED_ID_PATTERN, '$1')
        // 只删独立的 #数字 编号：6 位股票代码、#1a2b3c 颜色、URL 锚点都不动。
        .replace(/(^|[^\w/&])#\d{1,5}(?=[\s，。；、）)]|$)/g, '$1')
        // 只剥全角竖线；ASCII | 是 GFM 表格语法。
        .replace(/^[ \t]*｜[ \t]*/, '')
        .replace(/（\s*）/g, '')
        .replace(/\(\s*\)/g, '')
        .replace(/[ \t]+([，。；、）])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ');
      return lead + cleaned + trail;
    })
    .join('\n');
}
