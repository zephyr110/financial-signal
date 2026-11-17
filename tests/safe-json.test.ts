import { describe, it, expect } from 'vitest'
import { sanitizeErrorMessage } from '../lib/safe-json'

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
})
