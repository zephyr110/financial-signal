import type { PaperSummaryAction } from '@/lib/paper/summary'

/** 模拟盘页面共用的中文标签与数值口径。 */

export const EXPERIMENT_STATUS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  planned: '未开始',
  closed: '已关闭',
}

export const ACTION_LABEL: Record<PaperSummaryAction, string> = {
  setup: '先建实验',
  start: '开始实验',
  resume: '恢复实验',
  review_cards: '确认决策卡',
  wait_settlement: '等待结算',
  hold: '保持观察',
  blocked: '暂停操作',
}

export const CARD_STATUS: Record<string, string> = {
  active: '待确认',
  triggered: '已触发',
  confirmed: '已确认',
  executed: '已执行',
  not_triggered: '未触发',
  invalidated: '已失效',
  expired: '已过期',
  dismissed: '已忽略',
}

export const STANCE_LABEL: Record<string, string> = {
  candidate: '候选买入',
  observe: '观察',
  caution: '谨慎',
  avoid: '回避',
}

export const ORDER_STATUS: Record<string, string> = {
  confirmed: '已确认',
  settlement_pending: '待结算',
  filled: '已成交',
  rejected: '已拒绝',
  expired: '已过期',
  trigger_not_met: '未触发',
  canceled: '已撤销',
}

export const RISK_LABEL: Record<string, string> = {
  pass: '数据正常',
  warn: '数据警告',
  fail: '数据失败',
}

export const RECON_STATUS: Record<string, string> = {
  pass: '对账通过',
  fail: '对账不平衡',
  missing_price: '缺价挂起',
}

export function formatBpPct(bp: number | null | undefined, signed = true): string {
  if (bp == null || !Number.isFinite(bp)) return '—'
  const value = bp / 100
  const sign = signed && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN')
}

export function positiveTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'ck-flat'
  return value > 0 ? 'ck-up' : 'ck-down'
}

export function reasonLabel(reason: string): string {
  return {
    not_confirmed: '未确认',
    off_plan: '计划外操作',
    risk_blocked: '风控拦截',
    data_blocked: '数据不足',
  }[reason] ?? reason
}

export function gateDecisionLabel(decision: string): string {
  return {
    pass: '通过',
    fail: '未通过',
    blocked: '待补证据',
  }[decision] ?? decision
}
