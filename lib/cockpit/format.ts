import type { ConfidenceLabel, SourceTier } from './types'

const yuan = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** 分 → 带货币符号的元；持仓总览用整数万/亿压缩。 */
export function formatCny(cents: number, compact = false): string {
  if (!Number.isFinite(cents)) return '—'
  const value = cents / 100
  if (!compact) return `¥${yuan.format(value)}`
  if (Math.abs(value) >= 1e8) return `¥${(value / 1e8).toFixed(2)}亿`
  if (Math.abs(value) >= 1e4) return `¥${(value / 1e4).toFixed(2)}万`
  return `¥${yuan.format(value)}`
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(2)
}

export function formatSignedPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function formatYi(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value).toLocaleString('zh-CN')} 亿`
}

export function formatDateCn(date: string): string {
  const d = new Date(`${date}T12:00:00+08:00`)
  if (Number.isNaN(d.getTime())) return date
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(d)
  return `${d.getUTCFullYear()}年${String(d.getUTCMonth() + 1).padStart(2, '0')}月${String(d.getUTCDate()).padStart(2, '0')}日 ${weekday}`
}

export function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

/** 交易日期本身已是上海日期，避免用本地时区再转一次。 */
export function formatShortDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

export function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

export function confidenceLabel(score: number): ConfidenceLabel {
  if (score < 0.55) return '低'
  if (score <= 0.75) return '中'
  return '高'
}

export function tierLabel(tier: SourceTier): string {
  return ['T0 官方', 'T1 持牌', 'T2 聚合', 'T3 社交'][tier] || '未知来源'
}

export function thesisStatusLabel(status: string): string {
  return {
    active: '论证中',
    strengthened: '证据增强',
    weakened: '出现反证',
    broken: '论点失效',
    review_due: '待复核',
  }[status] || status
}

export function taskStatusLabel(status: string): string {
  return {
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    failed: '失败',
    canceled: '已取消',
  }[status] || status
}

export function formatCost(micros: number): string {
  if (!micros) return '¥0.0000'
  return `¥${(micros / 1e6).toFixed(4)}`
}
