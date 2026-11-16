import {
  Bot,
  Briefcase,
  CalendarDays,
  ChartNoAxesCombined,
  LayoutDashboard,
  ListChecks,
  Newspaper,
  NotebookPen,
  Radar,
  Star,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

// 顶层只留五个模块；其余研究入口收进第二组，详情页仍归属各自模块高亮。
export const PRIMARY_ITEMS: NavItem[] = [
  { href: '/', label: '驾驶舱', icon: LayoutDashboard, match: (p) => p === '/' },
  { href: '/desk', label: '投研台', icon: Radar, match: (p) => p === '/desk' },
  {
    href: '/watchlist',
    label: '自选',
    icon: Star,
    match: (p) => p === '/watchlist' || p.startsWith('/stock/'),
  },
  { href: '/portfolio', label: '持仓', icon: Briefcase, match: (p) => p === '/portfolio' },
  { href: '/tasks', label: '任务', icon: ListChecks, match: (p) => p === '/tasks' },
]

export const SECONDARY_ITEMS: NavItem[] = [
  { href: '/today', label: '收盘简报', icon: CalendarDays, match: (p) => p === '/today' },
  { href: '/news', label: '新闻线索', icon: Newspaper, match: (p) => p === '/news' },
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

export const SIDEBAR_GROUPS = [
  { label: '主模块', items: PRIMARY_ITEMS },
  { label: '研究', items: SECONDARY_ITEMS },
]

// 简报与新闻线索是同一份日常信息的两个视图；顺序即页内切换顺序。
export const TODAY_VIEWS = [
  { href: '/today', label: '收盘简报', icon: CalendarDays, key: 'brief' },
  { href: '/news', label: '新闻线索', icon: Newspaper, key: 'news' },
] as const

export type TodayView = (typeof TODAY_VIEWS)[number]['key']

// 手机底栏固定五个主模块。显式列出 href：新增侧栏项不会悄悄挤进 grid-cols-5。
const MOBILE_HREFS = ['/', '/desk', '/watchlist', '/portfolio', '/tasks']
const ALL_NAV_ITEMS = [...PRIMARY_ITEMS, ...SECONDARY_ITEMS]

export const MOBILE_ITEMS: NavItem[] = MOBILE_HREFS
  .map((href) => ALL_NAV_ITEMS.find((item) => item.href === href))
  .filter((item): item is NavItem => Boolean(item))
