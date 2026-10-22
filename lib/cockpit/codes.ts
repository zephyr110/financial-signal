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
    // 北交所：4/8 开头及 920 新代码段；沪市：5 基金、6 股票、9 B 股、11 转债、7 申购。
    const suffix = /^(4|8|92)/.test(value)
      ? 'BJ'
      : /^(5|6|9|11|7)/.test(value) ? 'SH' : 'SZ'
    return `${value}.${suffix}`
  }
  const prefixed = value.match(/^(SH|SZ|BJ)(\d{6})$/)
  return prefixed ? `${prefixed[2]}.${prefixed[1]}` : null
}
