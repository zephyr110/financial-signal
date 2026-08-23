'use strict';

// 注意:与 lib/pipeline.ts 的 PIPELINE_JOBS 保持一致(改动需两边同步;
// tests/electron/scheduler-core.test.js 有相等性断言防止漂移)。
const PIPELINE_JOBS = ['fetch', 'analyze', 'deep-analyze', 'event-threads', 'fetch-market'];

/** 未配 LLM key 时只抓取不分析。 */
function buildJobSequence({ llmConfigured }) {
  return llmConfigured ? [...PIPELINE_JOBS] : ['fetch'];
}

/** 是否已配置 LLM:app_settings 的 llm_api_key 非空,或环境变量(与 lib/llm/config.ts 一致)。 */
function isLlmConfigured(settings) {
  return Boolean(
    (settings && settings.llm_api_key) ||
      process.env.LLM_API_KEY ||
      process.env.DEEPSEEK_API_KEY
  );
}

module.exports = { PIPELINE_JOBS, buildJobSequence, isLlmConfigured };
