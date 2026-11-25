export type TodayBriefState = 'current' | 'closed' | 'pending-close' | 'pending-generate' | 'unknown'

/** 今日页只把 trade_date 等于今天的报告当作“今日简报”，其余情况必须显式提示。 */
export function todayBriefState(input: {
  reportDate: string
  today: string
  latestMarketDate: string | null
  marketOpen: boolean | null
}): TodayBriefState {
  if (input.reportDate === input.today) return 'current'
  if (input.marketOpen === false) return 'closed'
  if (input.latestMarketDate === input.today) return 'pending-generate'
  if (input.marketOpen === true) return 'pending-close'
  return 'unknown'
}
