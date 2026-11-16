import { useCallback, useEffect, useState } from 'react'

type DbActionResult = { ok?: boolean; canceled?: boolean; error?: string }
type DesktopBridge = {
  getInfo?: () => Promise<{ imported?: boolean }>
  selectAndImportDb?: () => Promise<DbActionResult>
  createFreshDb?: () => Promise<DbActionResult>
}

function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  return ((window as unknown as { desktop?: DesktopBridge }).desktop ?? null)
}

/**
 * 桌面端首次启动引导。判定完成前调用方不得发请求：
 * /api/* 会先让服务端 getDb() 建出空库，之后 imported 恒 true，欢迎页再也不出现。
 */
export function useDesktopWelcome() {
  const [showWelcome, setShowWelcome] = useState(false)
  const [checked, setChecked] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge?.getInfo) {
      setChecked(true)
      return
    }
    bridge
      .getInfo()
      .then((info) => {
        setChecked(true)
        if (!info.imported) setShowWelcome(true)
      })
      .catch(() => {
        // IPC 异常按未导入处理：误判已导入会让用户永远看不到导入入口
        setChecked(true)
        setShowWelcome(true)
      })
  }, [])

  const run = useCallback(async (action: 'import' | 'fresh') => {
    const bridge = desktopBridge()
    if (!bridge) return
    const failMsg = action === 'import' ? '导入失败，请重试' : '创建数据库失败，请重试'
    setImporting(true)
    setImportError(null)
    try {
      const result = action === 'import'
        ? await bridge.selectAndImportDb?.()
        : await bridge.createFreshDb?.()
      if (result?.ok) setShowWelcome(false)
      else if (action === 'import' && result?.canceled) return
      else setImportError(result?.error || failMsg)
    } catch (err) {
      // 对话框在退出过程中被销毁时按钮会卡在“导入中”，必须兜底复位
      console.error(`[welcome] ${action} failed:`, err)
      setImportError(failMsg)
    } finally {
      setImporting(false)
    }
  }, [])

  return {
    showWelcome,
    checked,
    importing,
    importError,
    handleImport: () => run('import'),
    handleSkip: () => run('fresh'),
  }
}
