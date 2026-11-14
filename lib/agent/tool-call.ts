import { looksLikeJson, parseJsonLike, repairJson } from './format'

/** 从模型文本里识别工具调用；散文中的行内 JSON 不执行。 */
function parseToolCallCandidate(text: string): { tool?: string; args?: Record<string, unknown> } | null {
  const trimmed = (text || '').trim()
  const parsed = parseJsonLike(trimmed)
  if (parsed && typeof parsed === 'object' && typeof (parsed as { tool?: unknown }).tool === 'string') {
    const p = parsed as { tool: string; args?: unknown }
    return { tool: p.tool, args: p.args && typeof p.args === 'object' ? (p.args as Record<string, unknown>) : {} }
  }
  if (!looksLikeJson(trimmed)) return null
  const repaired = repairJson(trimmed)
  if (repaired !== null && repaired !== trimmed) {
    try {
      const parsedRetry = JSON.parse(repaired) as { tool?: unknown; args?: unknown }
      if (parsedRetry && typeof parsedRetry === 'object' && typeof parsedRetry.tool === 'string') {
        return {
          tool: parsedRetry.tool,
          args: parsedRetry.args && typeof parsedRetry.args === 'object'
            ? (parsedRetry.args as Record<string, unknown>)
            : {},
        }
      }
    } catch {
      // 放弃
    }
  }
  return null
}

export function tryParseToolCall(content: string): { tool?: string; args?: Record<string, unknown> } | null {
  const trimmed = (content || '').trim()
  const direct = parseToolCallCandidate(trimmed)
  if (direct?.tool) return direct

  // 说明文字 + 独立末行工具 JSON（常见误输出；行内引用 JSON 仍不解析）
  const lines = trimmed.split('\n')
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim()
    const tail = parseToolCallCandidate(lastLine)
    if (tail?.tool) return tail
  }

  const fenceMatch = trimmed.match(/\n```(?:json)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fenceMatch) {
    const tail = parseToolCallCandidate(`\`\`\`json\n${fenceMatch[1]}\n\`\`\``)
    if (tail?.tool) return tail
  }

  return null
}
