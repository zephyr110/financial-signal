/**
 * Generic OpenAI-compatible Chat Completions Client.
 *
 * Works with DeepSeek, OpenAI, Groq, Together, vLLM/Ollama, and any
 * provider that exposes an OpenAI-compatible /v1/chat/completions endpoint.
 */

import { LLM_CONFIG, getChatCompletionsUrl, getEffectiveLlmConfig, PRICING } from './config';

export const usageLog = [];

/** usageLog 保留上限:桌面端长驻进程会无限累计,数组必须封顶防内存增长。 */
const USAGE_LOG_MAX = 1000;

function pushUsage(entry) {
  usageLog.push(entry);
  if (usageLog.length > USAGE_LOG_MAX) usageLog.splice(0, usageLog.length - USAGE_LOG_MAX);
}

/**
 * OpenAI-compatible chat completion.
 *
 * @param stream  为 true 时使用 SSE 流式响应，逐段回调 onDelta(text)
 * @param onDelta 流式时每个内容片段回调（用于前端打字机式展示）
 */
export async function chatCompletion({ systemPrompt = undefined, userMessage = undefined, messages = undefined, extra = undefined, temperature = undefined, maxTokens = undefined, stream = false, onDelta = undefined }) {
  // 运行时设置（设置弹窗）优先于环境变量：model/baseUrl/apiKey 每次调用读取（30s 缓存）
  const cfg = await getEffectiveLlmConfig();
  const url = (cfg.baseUrl || LLM_CONFIG.baseUrl).replace(/\/+$/, '');
  const completionsUrl =
    url.endsWith('/chat/completions')
      ? url
      : url.endsWith('/v1')
        ? `${url}/chat/completions`
        : `${url}/v1/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_CONFIG.timeoutMs);

  try {
    const body = {
      model: cfg.model,
      // messages 优先（多轮/工具调用场景），否则降级为 system+user 单轮
      messages: messages ?? [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: temperature ?? LLM_CONFIG.temperature,
      max_tokens: maxTokens ?? LLM_CONFIG.maxTokens,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
      ...extra,
    };

    const res = await fetch(completionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
    }

    if (!stream) {
      const json = await res.json();
      const entry = {
        timestamp: new Date().toISOString(),
        model: cfg.model,
        usage: json.usage,
      };
      pushUsage(entry);
      const content = json.choices?.[0]?.message?.content || '';
      return { content, usage: json.usage, model: cfg.model };
    }

    // ── SSE 流式解析 ──
    const reader = res.body?.getReader();
    if (!reader) throw new Error('LLM stream not supported');

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta?.(delta);
          }
          if (json.usage) usage = json.usage;
        } catch {
          // 忽略不完整/非 JSON 数据行
        }
      }
    }

    pushUsage({
      timestamp: new Date().toISOString(),
      model: cfg.model,
      usage,
    });
    return { content, usage, model: cfg.model };
  } finally {
    clearTimeout(timeout);
  }
}

export function getUsageStats() {
  return usageLog.reduce(
    (acc, e) => ({
      prompt_tokens: acc.prompt_tokens + (e.usage?.prompt_tokens || 0),
      completion_tokens: acc.completion_tokens + (e.usage?.completion_tokens || 0),
      total_tokens: acc.total_tokens + (e.usage?.total_tokens || 0),
      calls: acc.calls + 1,
      errors: acc.errors + (e.error ? 1 : 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, errors: 0 }
  );
}

export function getCostEstimate() {
  const stats = getUsageStats();
  const inputCost = (stats.prompt_tokens / 1_000_000) * PRICING.inputPerMillion;
  const outputCost = (stats.completion_tokens / 1_000_000) * PRICING.outputPerMillion;
  const total = Math.round((inputCost + outputCost) * 1000) / 1000;
  return {
    ...stats,
    estimated_cost: total,
    estimated_cost_rmb: total, // backward compat
    input_cost: Math.round(inputCost * 1000) / 1000,
    output_cost: Math.round(outputCost * 1000) / 1000,
    currency: PRICING.currency,
  };
}
