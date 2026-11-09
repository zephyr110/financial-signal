import {
  Bot,
  Briefcase,
  CalendarDays,
  ChartNoAxesCombined,
  ListChecks,
  NotebookPen,
  Star,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

// “今日”同时覆盖收盘简报（/today）与新闻线索（/），两个视图共用这一入口。
export const TODAY_ITEMS: NavItem[] = [
  {
    href: '/today',
    label: '今日',
    icon: CalendarDays,
    match: (p) => p === '/today' || p === '/',
  },
  {
    href: '/watchlist',
    label: '自选',
    icon: Star,
    match: (p) => p === '/watchlist' || p.startsWith('/stock/'),
  },
  { href: '/portfolio', label: '持仓', icon: Briefcase, match: (p) => p === '/portfolio' },
]

export const RESEARCH_ITEMS: NavItem[] = [
  { href: '/research', label: '研究笔记', icon: NotebookPen, match: (p) => p === '/research' },
  {
    href: '/analysis',
    label: '信号分析',
    icon: ChartNoAxesCombined,
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

export const SYSTEM_ITEMS: NavItem[] = [
  { href: '/tasks', label: '任务中心', icon: ListChecks, match: (p) => p === '/tasks' },
]

export const SIDEBAR_GROUPS = [
  { label: '日常', items: TODAY_ITEMS },
  { label: '研究', items: RESEARCH_ITEMS },
  { label: '系统', items: SYSTEM_ITEMS },
]

// 手机底栏只放五个最高频入口；新闻线索在“今日”页内切换。
export const MOBILE_ITEMS: NavItem[] = TODAY_ITEMS.slice(0, 3).concat(
  RESEARCH_ITEMS.slice(0, 1),
  SYSTEM_ITEMS,
)
