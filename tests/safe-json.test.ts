import { describe, it, expect } from 'vitest'
import { sanitizeErrorMessage, sanitizeToolSummary } from '../lib/safe-json'

describe('sanitizeErrorMessage', () => {
  it('隐藏接口地址与 IP，但保留可行动的失败原因', () => {
    expect(sanitizeErrorMessage('request failed: api.deepseek.com/v1/chat')).toBe(
      'request failed: （接口地址已隐藏）',
    )
    expect(sanitizeErrorMessage('connect ECONNREFUSED 127.0.0.1:5432')).toContain('（接口地址已隐藏）')
    expect(sanitizeErrorMessage('打开 https://example.com/x 失败')).toBe('打开 （接口地址已隐藏） 失败')
  })

  it('文件名与源码位置不能被当成主机名抹掉', () => {
    expect(sanitizeErrorMessage('读取 db-config.json 失败')).toBe('读取 db-config.json 失败')
    expect(sanitizeErrorMessage('analysis.tsx:42:5 抛错')).toBe('analysis.tsx:42:5 抛错')
    expect(sanitizeErrorMessage('at /app/lib/db.ts:12')).toBe('at /app/lib/db.ts:12')
    expect(sanitizeErrorMessage('database is locked: news_archive.db')).toBe(
      'database is locked: news_archive.db',
    )
  })

  it('股票代码与普通小数不误伤', () => {
    expect(sanitizeErrorMessage('600519.SH 行情缺失')).toBe('600519.SH 行情缺失')
    expect(sanitizeErrorMessage('平均分 4.5')).toBe('平均分 4.5')
  })

  it('大写主机名同样脱敏', () => {
    expect(sanitizeErrorMessage('API.TUSHARE.PRO timeout')).toBe('（接口地址已隐藏） timeout')
  })

  it('非 http scheme 与带端口/路径的主机名同样不泄漏', () => {
    expect(sanitizeErrorMessage('connect libsql://mydb.turso.io failed'))
      .toBe('connect （接口地址已隐藏） failed')
    expect(sanitizeErrorMessage('ws://mac-mini.local:3010 拒绝连接'))
      .toBe('（接口地址已隐藏） 拒绝连接')
    expect(sanitizeErrorMessage('api.example.sh:443 timeout'))
      .toBe('（接口地址已隐藏） timeout')
    expect(sanitizeErrorMessage('123456.com 无法解析'))
      .toBe('（接口地址已隐藏） 无法解析')
  })

  it('异常类名、汇率对与港股代码不被误伤', () => {
    expect(sanitizeErrorMessage('sqlite3.OperationalError: no such table'))
      .toBe('sqlite3.OperationalError: no such table')
    expect(sanitizeErrorMessage('USD.CNY 汇率缺失')).toBe('USD.CNY 汇率缺失')
    expect(sanitizeErrorMessage('00700.HK 行情缺失')).toBe('00700.HK 行情缺失')
  })
})

describe('sanitizeToolSummary', () => {
  it('保留 6 位股票代码，去掉预警/判断编号', () => {
    expect(sanitizeToolSummary('贵州茅台 #600519 收盘 1680.00')).toBe('贵州茅台 #600519 收盘 1680.00')
    expect(sanitizeToolSummary('中芯国际 #688981.SH 放量')).toBe('中芯国际 #688981.SH 放量')
    expect(sanitizeToolSummary('预警 #123 alert:2026-01-01:policy:ab')).toBe('预警')
  })
})
