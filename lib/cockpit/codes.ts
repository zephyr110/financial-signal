const CODE_RE = /^\d{6}\.(SH|SZ|BJ)$/

/**
 * 接受 600519、600519.SH、SH600519 三种写法；只做格式规范化，不验证标的是否真实存在。
 * 没入库的代码允许先加入自选，但页面必须显示“待行情入库”，不能补造名称或价格。
 */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim().toUpperCase()
  if (CODE_RE.test(value)) return value
  if (/^\d{6}$/.test(value)) {
    const suffix = value.startsWith('6') ? 'SH' : value.startsWith('4') || value.startsWith('8') ? 'BJ' : 'SZ'
    return `${value}.${suffix}`
  }
  const prefixed = value.match(/^(SH|SZ|BJ)(\d{6})$/)
  return prefixed ? `${prefixed[2]}.${prefixed[1]}` : null
}
