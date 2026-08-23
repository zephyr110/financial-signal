import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadConfig, saveConfig } from '../../electron/store'

let dir, file

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-'))
  file = path.join(dir, 'config.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    const cfg = loadConfig(file, { intervalMs: 1800000 })
    expect(cfg.intervalMs).toBe(1800000)
  })

  it('reads existing file and merges defaults', () => {
    fs.writeFileSync(file, JSON.stringify({ intervalMs: 600000 }))
    const cfg = loadConfig(file, { intervalMs: 1800000, notifyLastRunAt: null })
    expect(cfg.intervalMs).toBe(600000)
    expect(cfg).toHaveProperty('notifyLastRunAt')
  })

  it('falls back to defaults on corrupt file', () => {
    fs.writeFileSync(file, '{not json')
    const cfg = loadConfig(file, { intervalMs: 1800000 })
    expect(cfg.intervalMs).toBe(1800000)
  })
})

describe('saveConfig', () => {
  it('writes file readable by loadConfig', () => {
    saveConfig(file, { intervalMs: 900000, notifyLastRunAt: '2026-08-23T10:00:00Z' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      intervalMs: 900000,
      notifyLastRunAt: '2026-08-23T10:00:00Z',
    })
  })
})
