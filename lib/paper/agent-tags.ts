/** agent 卡片 id 前缀；独立小模块供 agent、jobs、metrics、API 共用，避免循环依赖。 */
export const AGENT_CARD_PREFIX = 'acard-'

export function isAgentCardId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(AGENT_CARD_PREFIX)
}
