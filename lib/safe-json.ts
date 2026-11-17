/** 对外输出 JSON 前剥掉模型名、请求/会话 ID 等内部字段（设置弹窗除外）。 */
const INTERNAL_JSON_KEYS = new Set([
  'model', 'narrativeModel', 'requestId', 'request_id', 'traceId', 'trace_id',
  'sessionId', 'session_id', 'taskId', 'task_id', 'messageId', 'message_id', 'turnId', 'turn_id',
  'apiKey', 'api_key', 'token', 'secret', 'password',
]);

export function publicJson(value: unknown): string {
  return JSON.stringify(value, (key, v) => (INTERNAL_JSON_KEYS.has(key) ? undefined : v)) ?? 'null';
}
