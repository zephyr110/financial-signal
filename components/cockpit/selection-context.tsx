import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/router'
import { track } from '@/lib/track'
import {
  EMPTY_SELECTION,
  hasSelection,
  normalizeSymbol,
  parseSelectionQuery,
  withSelectionQuery,
  type CockpitSelection,
} from '@/lib/selection'

interface SelectionContextValue extends CockpitSelection {
  open: boolean
  openSymbol: (code: string) => void
  openThread: (id: number) => void
  clear: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

/**
 * 全局选中态以 URL 为准：深链可直接打开抽屉，浏览器前进/后退自动还原。
 * SSR 渲染空选中，客户端 effect 再应用 query，避免水合不一致。
 */
export function CockpitSelectionProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [source, setSource] = useState<CockpitSelection>(EMPTY_SELECTION)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    setSource(parseSelectionQuery(router.query))
  }, [router.query.symbol, router.query.thread])

  const apply = useCallback(
    (next: CockpitSelection, mode: 'push' | 'replace') => {
      setSource(next)
      const query = withSelectionQuery(router.query, next)
      const url = { pathname: router.pathname, query }
      if (mode === 'push') void router.push(url, undefined, { shallow: true, scroll: false })
      else void router.replace(url, undefined, { shallow: true, scroll: false })
    },
    [router],
  )

  const openSymbol = useCallback(
    (code: string) => {
      const symbol = normalizeSymbol(code)
      if (!symbol) return
      track('cockpit_selection_open', { kind: 'symbol', code: symbol })
      if (typeof document !== 'undefined') restoreFocusRef.current = document.activeElement as HTMLElement
      // 首次打开进一条历史记录，back 即可关闭；换标的只改当前记录，不刷历史
      apply({ symbol, thread: null }, hasSelection(source) ? 'replace' : 'push')
    },
    [apply, source],
  )

  const openThread = useCallback(
    (id: number) => {
      if (!Number.isSafeInteger(id) || id <= 0) return
      track('cockpit_selection_open', { kind: 'thread', id })
      if (typeof document !== 'undefined') restoreFocusRef.current = document.activeElement as HTMLElement
      apply({ symbol: null, thread: id }, hasSelection(source) ? 'replace' : 'push')
    },
    [apply, source],
  )

  const clear = useCallback(() => {
    apply(EMPTY_SELECTION, 'replace')
  }, [apply])

  // 关闭后把焦点还给触发元素；元素已卸载则浏览器自行处理
  useEffect(() => {
    const open = hasSelection(source)
    if (wasOpenRef.current && !open) {
      const target = restoreFocusRef.current
      if (target?.isConnected) target.focus()
    }
    wasOpenRef.current = open
  }, [source])

  const value = useMemo<SelectionContextValue>(
    () => ({ ...source, open: hasSelection(source), openSymbol, openThread, clear }),
    [source, openSymbol, openThread, clear],
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

export function useCockpitSelection(): SelectionContextValue {
  const context = useContext(SelectionContext)
  if (!context) throw new Error('useCockpitSelection must be used within CockpitSelectionProvider')
  return context
}
