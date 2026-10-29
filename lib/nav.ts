import {
  BookOpen,
  Bot,
  Briefcase,
  ListChecks,
  Newspaper,
  Star,
  SunMedium,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

export const DAILY_ITEMS: NavItem[] = [
  { href: '/today', label: '今日收盘', icon: SunMedium, match: (p) => p === '/today' },
  {
    href: '/watchlist',
    label: '自选',
    icon: Star,
    match: (p) => p === '/watchlist' || p.startsWith('/stock/'),
  },
  { href: '/portfolio', label: '持仓', icon: Briefcase, match: (p) => p === '/portfolio' },
  { href: '/research', label: '研究', icon: BookOpen, match: (p) => p === '/research' },
  { href: '/tasks', label: '任务', icon: ListChecks, match: (p) => p === '/tasks' },
]

export const WORKBENCH_ITEMS: NavItem[] = [
  { href: '/', label: '新闻快讯', icon: Newspaper, match: (p) => p === '/' },
  {
    href: '/analysis',
    label: '信号分析',
    icon: TrendingUp,
    match: (p) =>
      p === '/analysis' || p.startsWith('/signal/') || p.startsWith('/thread/') || p === '/analytics/value',
  },
  {
    href: '/agent',
    label: '研究助手',
    icon: Bot,
    match: (p) => p === '/agent' || p.startsWith('/agent/'),
  },
]

export const SIDEBAR_GROUPS = [
  { label: '每日', items: DAILY_ITEMS },
  { label: '工作台', items: WORKBENCH_ITEMS },
]

export const MOBILE_ITEMS = DAILY_ITEMS

export function isCockpitPath(pathname: string): boolean {
  return DAILY_ITEMS.some((item) => item.match(pathname))
}
