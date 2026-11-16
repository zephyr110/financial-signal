import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/router'
import { Bot, LayoutGrid, RefreshCw, Search, Settings, Star } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { COCKPIT_PANELS } from '@/lib/cockpit-panels'
import {
  filterPaletteCommands,
  groupPaletteCommands,
  nextIndex,
  type PaletteFilterable,
} from '@/lib/command-palette'
import { PRIMARY_ITEMS, SECONDARY_ITEMS } from '@/lib/nav'
import { track } from '@/lib/track'
import { cn } from '@/lib/utils'

interface PaletteCommand extends PaletteFilterable {
  id: string
  hint?: string
  icon?: ReactNode
  run: () => void
}

interface PaletteSymbol {
  code: string
  name: string
}

/**
 * 全局命令面板：⌘K / Ctrl+K 打开，顶栏也有入口。
 * 标的搜索按需拉取一次聚合接口，失败不影响页面跳转类命令。
 */
export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [symbols, setSymbols] = useState<PaletteSymbol[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const composingRef = useRef(false)
  const symbolsRequestedRef = useRef(false)

  const openPalette = useCallback(() => {
    track('command_palette_open')
    restoreFocusRef.current = document.activeElement as HTMLElement
    setQuery('')
    setActive(0)
    setOpen(true)
  }, [])

  const setOpenSafe = useCallback((next: boolean) => {
    setOpen(next)
    if (!next && restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (open) setOpenSafe(false)
        else openPalette()
      }
    }
    const onOpen = () => openPalette()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('app:command-open', onOpen)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('app:command-open', onOpen)
    }
  }, [open, openPalette, setOpenSafe])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open || symbolsRequestedRef.current) return
    symbolsRequestedRef.current = true
    const controller = new AbortController()
    fetch('/api/dashboard?sections=watchlist,portfolio', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const sections = body?.data?.sections
        const found = new Map<string, PaletteSymbol>()
        const watchlist = sections?.watchlist
        if (watchlist?.ok && Array.isArray(watchlist.data)) {
          for (const item of watchlist.data) found.set(item.code, { code: item.code, name: item.name })
        }
        const portfolio = sections?.portfolio
        if (portfolio?.ok && Array.isArray(portfolio.data?.positions)) {
          for (const item of portfolio.data.positions) {
            if (!found.has(item.code)) found.set(item.code, { code: item.code, name: item.name })
          }
        }
        setSymbols([...found.values()])
      })
      .catch(() => {
        // 下次打开再试；不阻塞页面跳转
        symbolsRequestedRef.current = false
      })
    return () => controller.abort()
  }, [open])

  const commands: PaletteCommand[] = [
    ...[...PRIMARY_ITEMS, ...SECONDARY_ITEMS].map((item) => ({
      id: `page:${item.href}`,
      label: item.label,
      group: '页面',
      keywords: [item.href],
      icon: <item.icon className="size-3.5" aria-hidden="true" />,
      run: () => { void router.push(item.href) },
    })),
  ]

  if (router.pathname === '/') {
    COCKPIT_PANELS.forEach((panel) => {
      commands.push({
        id: `panel:${panel.key}`,
        label: `切换面板 · ${panel.label}`,
        group: '面板',
        keywords: ['显示', '隐藏', panel.key],
        icon: <LayoutGrid className="size-3.5" aria-hidden="true" />,
        run: () => {
          window.dispatchEvent(new CustomEvent('app:toggle-panel', { detail: { key: panel.key } }))
        },
      })
    })
    commands.push({
      id: 'action:refresh',
      label: '刷新驾驶舱数据',
      group: '操作',
      keywords: ['刷新', '更新'],
      icon: <RefreshCw className="size-3.5" aria-hidden="true" />,
      run: () => { window.dispatchEvent(new Event('app:refresh-data')) },
    })
    commands.push({
      id: 'action:copilot',
      label: '打开 Copilot',
      group: '操作',
      keywords: ['研究助手', '提问', 'ai'],
      icon: <Bot className="size-3.5" aria-hidden="true" />,
      run: () => { window.dispatchEvent(new Event('app:copilot-toggle')) },
    })
  }

  symbols.forEach((symbol) => {
    commands.push({
      id: `symbol:${symbol.code}`,
      label: `${symbol.name} ${symbol.code}`,
      group: '标的',
      keywords: [symbol.code, symbol.name],
      icon: <Star className="size-3.5" aria-hidden="true" />,
      run: () => {
        if (router.pathname === '/') {
          void router.push(
            { pathname: '/', query: { ...router.query, symbol: symbol.code } },
            undefined,
            { shallow: true, scroll: false },
          )
        } else {
          void router.push(`/stock/${encodeURIComponent(symbol.code)}`)
        }
      },
    })
  })

  commands.push({
    id: 'action:settings',
    label: '打开设置',
    group: '操作',
    keywords: ['偏好', '外观', '账户'],
    icon: <Settings className="size-3.5" aria-hidden="true" />,
    run: () => { window.dispatchEvent(new Event('app:open-settings')) },
  })

  const results = filterPaletteCommands(commands, query)
  const groups = groupPaletteCommands(results)
  const activeCommand = results[active]

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const el = document.querySelector<HTMLElement>(`[data-palette-index="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const runCommand = useCallback((command: PaletteCommand | undefined) => {
    if (!command) return
    setOpenSafe(false)
    command.run()
  }, [setOpenSafe])

  return (
    <Dialog open={open} onOpenChange={setOpenSafe}>
      <DialogContent
        className="top-[15%] max-h-[70dvh] w-full translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">搜索与命令</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((current) => nextIndex(current, results.length, 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((current) => nextIndex(current, results.length, -1))
              } else if (event.key === 'Enter') {
                if (composingRef.current || event.nativeEvent.isComposing) return
                event.preventDefault()
                runCommand(activeCommand)
              }
            }}
            placeholder="搜索页面、面板、自选与持仓标的…"
            aria-label="搜索与命令"
            role="combobox"
            aria-expanded
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeCommand ? `palette-${activeCommand.id}` : undefined}
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border px-1 py-0.5 text-[10px] text-muted-foreground sm:block">Esc</kbd>
        </div>

        <div id="command-palette-listbox" className="max-h-[50dvh] overflow-y-auto overscroll-contain p-1.5 [scrollbar-gutter:stable]" role="listbox" aria-label="命令">
          {results.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的页面或标的</p>
          ) : (
            groups.map((group) => (
              <div key={group.group} className="mb-1 last:mb-0">
                <p className="px-2 py-1 text-[10px] font-medium text-muted-foreground">{group.group}</p>
                {group.items.map((command) => {
                  const index = results.indexOf(command)
                  const selected = index === active
                  return (
                    <button
                      key={command.id}
                      id={`palette-${command.id}`}
                      data-palette-index={index}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => runCommand(command)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        selected ? 'bg-accent text-accent-foreground' : 'text-foreground',
                      )}
                    >
                      <span className="shrink-0 text-muted-foreground">{command.icon}</span>
                      <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span className="ml-auto">⌘K 随时唤起</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
