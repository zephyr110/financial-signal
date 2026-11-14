import {
  Bot,
  Briefcase,
  CalendarDays,
  ChartNoAxesCombined,
  FileText,
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
  { href: '/desk', label: '投研台', icon: Radar, match: (p) => p === '/desk' },
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

// 今日的两个视图；顺序即页内切换顺序。
export const TODAY_VIEWS = [
  { href: '/today', label: '收盘简报', icon: FileText, key: 'brief' },
  { href: '/', label: '新闻线索', icon: Newspaper, key: 'news' },
] as const

export type TodayView = (typeof TODAY_VIEWS)[number]['key']

// 手机底栏固定五个入口。显式列出 href：新增侧栏项不会悄悄挤进 grid-cols-5。
const MOBILE_HREFS = ['/today', '/desk', '/watchlist', '/portfolio', '/tasks']
const ALL_NAV_ITEMS = SIDEBAR_GROUPS.flatMap((group) => group.items)

export const MOBILE_ITEMS: NavItem[] = MOBILE_HREFS
  .map((href) => ALL_NAV_ITEMS.find((item) => item.href === href))
  .filter((item): item is NavItem => Boolean(item))
