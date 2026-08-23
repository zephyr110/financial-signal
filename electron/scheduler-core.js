'use strict';

/** 与 GitHub Actions 一致的管线顺序。 */
const PIPELINE_JOBS = ['fetch', 'analyze', 'deep-analyze', 'event-threads', 'fetch-market'];

/** 未配 LLM key 时只抓取不分析。 */
function buildJobSequence({ llmConfigured }) {
  return llmConfigured ? [...PIPELINE_JOBS] : ['fetch'];
}

/** 是否已配置 LLM(app_settings 的 llm_api_key 非空)。 */
function isLlmConfigured(settings) {
  return Boolean(settings && settings.llm_api_key);
}

/**
 * 最近抓取是否超过阈值(未抓取过视为 stale)。
 * 输入时间兼容 ISO-8601 与 SQLite 空格格式(datetime('now'),按 UTC 解释)。
 */
function isDataStale(lastFetchAt, nowIso, thresholdMs) {
  if (!lastFetchAt) return true;
  const t = lastFetchAt.includes('T') ? lastFetchAt : lastFetchAt.replace(' ', 'T') + 'Z';
  return Date.parse(nowIso) - Date.parse(t) > thresholdMs;
}

module.exports = { PIPELINE_JOBS, buildJobSequence, isLlmConfigured, isDataStale };
