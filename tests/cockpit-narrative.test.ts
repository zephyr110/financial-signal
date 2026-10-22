import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

/**
 * 叙述层只是可选解释：未配置 Key、输出含数字/建议或调用失败时都必须安静降级；
 * 每次真实调用仍要记录 token 与成本，避免“降级”变成不可见的费用黑洞。
 */

const chatCompletion = vi.hoisted(() => vi.fn())
vi.mock('../lib/llm/client', () => ({ chatCompletion }))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-narrative-test-'))
let narrative: typeof import('../lib/cockpit/narrative')
let settings: typeof import('../lib/settings')
let dbModule: typeof import('../lib/db')
let payload: import('../lib/cockpit/types').TodayPayload

describe('叙述层与问答降级', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.LLM_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.LLM_INPUT_PRICE
    delete process.env.LLM_OUTPUT_PRICE
    process.env.NEWS_DB_PATH = path.join(dir, 'narrative.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    settings = await import('../lib/settings')
    const demo = await import('../lib/cockpit/demo')
    const repo = await import('../lib/cockpit/repo')
    narrative = await import('../lib/cockpit/narrative')
    await demo.ensureCockpitDemoSeed()
    const demoPayload = await repo.getTodayPayload()
    if (!demoPayload) throw new Error('demo payload missing')
    payload = { ...demoPayload, isDemo: false }
  })

  beforeEach(async () => {
    chatCompletion.mockReset()
    await settings.setSettings({ [settings.SETTING_KEYS.LLM_API_KEY]: null })
  })

  async function usageCount(): Promise<number> {
    const db = await dbModule.getDb()
    const res = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM llm_usage', args: [] })
    return Number(res.rows[0]?.n || 0)
  }

  it('未配置 Key 时不调用模型，返回 null', async () => {
    const result = await narrative.generateBriefNarrative(payload)
    expect(result).toBeNull()
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('模型输出含数字或交易建议时丢弃，但仍记录用量', async () => {
    await settings.setSettings({ [settings.SETTING_KEYS.LLM_API_KEY]: 'test-key' })

    chatCompletion.mockResolvedValueOnce({
      content: '今日上涨 2.5%，量能配合。',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'mock-model',
    })
    expect(await narrative.generateBriefNarrative(payload, 'task-1')).toBeNull()

    chatCompletion.mockResolvedValueOnce({
      content: '证据之间相互印证，可以考虑加仓。',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'mock-model',
    })
    expect(await narrative.generateBriefNarrative(payload, 'task-1')).toBeNull()

    chatCompletion.mockResolvedValueOnce({
      content: '涨幅１２％，量能配合。',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'mock-model',
    })
    expect(await narrative.generateBriefNarrative(payload, 'task-1')).toBeNull()

    chatCompletion.mockResolvedValueOnce({
      content: '证据仍不足，建议继续持有并观望。',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'mock-model',
    })
    expect(await narrative.generateBriefNarrative(payload, 'task-1')).toBeNull()

    chatCompletion.mockResolvedValueOnce({
      content: '成交额较前一日放大三成。',
      usage: { prompt_tokens: 100, completion_tokens: 20 },
      model: 'mock-model',
    })
    expect(await narrative.generateBriefNarrative(payload, 'task-1')).toBeNull()

    expect(await usageCount()).toBe(5)
    const db = await dbModule.getDb()
    const usage = await db.execute({
      sql: 'SELECT task_id, model, prompt_tokens, completion_tokens, cost_micros FROM llm_usage ORDER BY rowid',
      args: [],
    })
    expect(usage.rows[0]?.task_id).toBe('task-1')
    expect(usage.rows[0]?.model).toBe('mock-model')
    expect(Number(usage.rows[0]?.cost_micros)).toBe(100 * 1 + 20 * 2)
  })

  it('合规输出附带模型名与提示词版本', async () => {
    await settings.setSettings({ [settings.SETTING_KEYS.LLM_API_KEY]: 'test-key' })
    chatCompletion.mockResolvedValueOnce({
      content: '价格与成交相互印证，但广度与指数走势出现分歧，证据仍不足以支持更强的结论。',
      usage: { prompt_tokens: 50, completion_tokens: 30 },
      model: 'mock-model',
    })
    const result = await narrative.generateBriefNarrative(payload)
    expect(result).toMatchObject({
      model: 'mock-model',
      promptVersion: narrative.NARRATIVE_PROMPT_VERSION,
    })
    expect(result?.text).toContain('广度')
    expect(result?.text).not.toMatch(/\d/)
  })

  it('问答未配置 Key 时用确定性证据摘要，并返回引用', async () => {
    const result = await narrative.answerBriefQuestion('今天的关键分歧是什么？', payload)
    expect(result.model).toBeNull()
    expect(result.answer).toContain(payload.hero.claim)
    expect(result.citations.length).toBeGreaterThan(0)
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  it('问答模型输出违规时回退，并说明回退原因', async () => {
    await settings.setSettings({ [settings.SETTING_KEYS.LLM_API_KEY]: 'test-key' })
    chatCompletion.mockResolvedValueOnce({
      content: '建议买入并设置目标价。',
      usage: { prompt_tokens: 10, completion_tokens: 10 },
      model: 'mock-model',
    })
    const result = await narrative.answerBriefQuestion('可以买吗？', payload)
    expect(result.model).toBeNull()
    expect(result.fallbackReason).toContain('合规校验')
    expect(result.answer).toContain(payload.hero.claim)
  })

  it('示例简报永不进入模型', async () => {
    await settings.setSettings({ [settings.SETTING_KEYS.LLM_API_KEY]: 'test-key' })
    const demoPayload = { ...payload, isDemo: true }
    expect(await narrative.generateBriefNarrative(demoPayload)).toBeNull()
    const answer = await narrative.answerBriefQuestion('怎么看？', demoPayload)
    expect(answer.model).toBeNull()
    expect(chatCompletion).not.toHaveBeenCalled()
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
