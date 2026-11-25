import { useEffect, useRef } from 'react'
import { useRouter } from 'next/router'

const POLL_MS = 30_000

/** 后台生成新简报后，停留在 /today 的页面自动重跑 GSSP，避免提示和正文冻结在旧日期。 */
export function TodayAutoRefresh({ signature }: { signature: string }) {
  const router = useRouter()
  const signatureRef = useRef(signature)
  signatureRef.current = signature
  const checkingRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      if (checkingRef.current || document.visibilityState !== 'visible') return
      checkingRef.current = true
      try {
        const res = await fetch('/api/cockpit/today', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        if (!res.ok) return
        const json = await res.json() as {
          data?: { tradeDate?: string; issueNo?: number; generatedAt?: string }
        }
        const next = json.data
          ? `${json.data.tradeDate}|${json.data.issueNo}|${json.data.generatedAt}`
          : ''
        if (!cancelled && next && next !== signatureRef.current) {
          await router.replace(router.asPath, undefined, { scroll: false })
        }
      } catch {
        // 下一轮再对齐，不打断阅读
      } finally {
        checkingRef.current = false
      }
    }

    const timer = window.setInterval(() => { void check() }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
