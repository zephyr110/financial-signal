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

export function displayToolArgs(args: unknown): string {
  return JSON.stringify(args, (key, value) => (ID_ARG_KEY.test(key) ? '…' : value), 2) ?? 'null';
}

/**
 * 任务失败文案会进任务中心与站内通知：去掉接口地址、请求 ID 与模型厂牌，
 * 只留下用户能据此行动的原因。
 */
export function sanitizeErrorMessage(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '（接口地址已隐藏）')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io)(?:\/[^\s"',)]*)?/gi, '（接口地址已隐藏）')
    .replace(/\b(?:deepseek|openai|anthropic|qwen|claude|gemini|llama)[\w.-]*/gi, '模型服务')
    .replace(/\brequest[ _-]?id\b[:=]?\s*["']?[A-Za-z0-9_-]+["']?/gi, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim() || '任务执行失败，请稍后重试';
}

/** 工具摘要展示用：去掉 #123、UUID 等内部编号，这些对读者没有意义。 */
export function sanitizeToolSummary(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/#[A-Za-z0-9_-]+/g, '')
        .replace(/\b(?:alert-evidence|doc|document|alert|judgment|industry|signal|project|memory|overseas):[^\s，。；、）)｜|]+/g, '')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
        .replace(/^[｜|]+/, '')
        .replace(/(信号|事件线索|文档|调查|任务|请求|会话|预警|判断)\s*(?:ID|id|Id)\s*[:：=]?\s*[A-Za-z0-9_-]+/g, '$1')
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
  return text
    .replace(/\b(?:alert-evidence|doc|document|alert|judgment|industry|signal|project|memory|overseas):[^\s，。；、）)｜|]+/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/(^|\n)[ \t]*[｜|]+[ \t]*/g, '$1')
    .replace(/(信号|事件线索|文档|调查|任务|请求|会话|预警|判断)\s*(?:ID|id|Id)\s*[:：=]?\s*[A-Za-z0-9_-]+/g, '$1')
    .replace(/#\d[\w-]*/g, '')
    .replace(/（\s*）/g, '')
    .replace(/[ \t]+([，。；、）])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}
