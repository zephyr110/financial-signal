import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { useTheme } from 'next-themes'
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Briefcase,
  LayoutGrid,
  ListChecks,
  Moon,
  Newspaper,
  Star,
  Sun,
  SunMedium,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import type { SourceHealth } from '@/lib/cockpit/types'
import { formatTime } from '@/lib/cockpit/format'
import { DemoBanner, SourceHealthRail } from './bits'
import { NotificationBell } from './notification-bell'

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  match: (pathname: string) => boolean
}

const NAV_ITEMS: NavItem[] = [
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

const WORKBENCH_ITEMS: NavItem[] = [
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

const BOTTOM_ITEMS: NavItem[] = [
  ...NAV_ITEMS,
  { href: '/', label: '工作台', icon: LayoutGrid, match: (p) => p === '/' },
]

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === 'dark'
  return (
    <button
      type="button"
      className={compact ? 'ck-icon-button ck-theme-toggle' : 'ck-button ck-button-ghost ck-button-small'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? '切换到浅色外观' : '切换到深色外观'}
      title={dark ? '浅色外观' : '深色外观'}
    >
      {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      {!compact && <span>{dark ? '浅色' : '深色'}</span>}
    </button>
  )
}

function useServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* 离线能力不可用时不影响在线使用 */
      })
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])
}

export function CockpitShell({
  title,
  eyebrow,
  subtitle,
  asOf,
  isDemo,
  actions,
  sourceHealth = [],
  children,
}: {
  title: string
  eyebrow?: string
  subtitle?: ReactNode
  asOf?: string
  isDemo?: boolean
  actions?: ReactNode
  sourceHealth?: SourceHealth[]
  children: ReactNode
}) {
  const router = useRouter()
  useServiceWorker()
  return (
    <div className="ck-root">
      <a className="ck-skip" href="#ck-main">跳到主要内容</a>
      <div className="ck-app">
        <aside className="ck-sidebar" aria-label="驾驶舱导航">
          <Link className="ck-brand" href="/today">
            <span className="ck-brand-mark" aria-hidden="true">收</span>
            <span className="ck-brand-text">
              <span className="ck-brand-name">收盘手记</span>
              <span className="ck-brand-en">AFTERCLOSE</span>
            </span>
          </Link>
          <nav className="ck-side-nav" aria-label="主导航">
            <p className="ck-side-label">收盘手记</p>
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const active = item.match(router.pathname)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`ck-side-link${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
            <p className="ck-side-label">财经信号工作台</p>
            {WORKBENCH_ITEMS.map((item) => {
              const Icon = item.icon
              const active = item.match(router.pathname)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`ck-side-link${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              )
            })}
          </nav>
          <div className="ck-sidebar-foot">
            <div className="ck-theme-row">
              <span>外观</span>
              <ThemeToggle />
            </div>
            <p className="ck-sidebar-legal">个人研究记录，不构成投资建议。</p>
          </div>
        </aside>

        <div className="ck-main">
          <header className="ck-topbar">
            <div className="ck-topbar-left">
              <span className="ck-topbar-kicker">收盘手记</span>
            </div>
            <div className="ck-topbar-actions">
              {asOf && <span className="ck-asof">更新 {formatTime(asOf)}</span>}
              {actions}
              <NotificationBell />
              <ThemeToggle compact />
            </div>
          </header>

          <div className="ck-content-wrap">
            <main className="ck-main-col" id="ck-main">
              <div className="ck-page-head">
                {eyebrow && <p className="ck-eyebrow">{eyebrow}</p>}
                <h1 className="ck-page-title">{title}</h1>
                {subtitle && <p className="ck-page-sub">{subtitle}</p>}
              </div>
              {isDemo && <DemoBanner />}
              {children}
              <footer className="ck-footer">
                <span>收盘手记 · 个人研究记录，不构成投资建议。</span>
                <span>数据先于判断。</span>
              </footer>
            </main>

            <aside className="ck-rail" aria-label="辅助信息">
              <section className="ck-rail-card">
                <h2 className="ck-rail-title">数据源状态</h2>
                <SourceHealthRail sources={sourceHealth} />
                <Link className="ck-rail-link" href="/tasks">
                  查看任务中心
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </section>
            </aside>
          </div>

          <nav className="ck-bottom-nav" aria-label="快捷导航">
            {BOTTOM_ITEMS.map((item) => {
              const Icon = item.icon
              const active = item.match(router.pathname)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`ck-bottom-link${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span className="ck-bottom-label">{item.label.replace('今日收盘', '今日')}</span>
                </Link>
              )
            })}
          </nav>
        </div>
      </div>
    </div>
  )
}
