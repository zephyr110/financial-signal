import { useState, type FormEvent } from 'react'
import { CalendarCheck, Check, LockKeyhole, Scale, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatCny } from '@/lib/cockpit/format'
import { cn } from '@/lib/utils'

const CASH_TIERS = [
  { cents: 10_000_000, label: '¥10 万', note: '先跑通流程' },
  { cents: 20_000_000, label: '¥20 万', note: '规格默认' },
  { cents: 50_000_000, label: '¥50 万', note: '更接近实盘仓位' },
] as const

const TERMS = [
  {
    icon: LockKeyhole,
    title: '开始即锁协议',
    text: '规则、费用、基准与阈值写进实验；之后改参数只能另建实验，不能借重置偷偷改。',
  },
  {
    icon: Scale,
    title: '统计有门槛',
    text: '不足 120 个有效交易日、最后一张卡不满 60 日或触发卡不足 30 张时，只报计数，不下“有效”结论。',
  },
  {
    icon: CalendarCheck,
    title: '按交易日计时',
    text: '09:15 前确认，16:20 按官方开盘价结算；休市与调休日不处理行情，只采集新闻与政策。',
  },
  {
    icon: ShieldCheck,
    title: '不碰真钱',
    text: '全程虚拟资金，不接券商、不发真实委托；页面只做个人研究记录，不构成投资建议。',
  },
]

export function PaperSetup({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [name, setName] = useState('L1 前向纸面')
  const [cash, setCash] = useState<number>(20_000_000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/paper/experiments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: name.trim(), initialCashCents: cash }),
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '实验创建失败。')
        return
      }
      await onChanged()
    } catch {
      setError('网络连接失败，实验未创建。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
      <section className="ck-card ck-card-pad" aria-labelledby="paper-setup-title">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">首次使用</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight" id="paper-setup-title">
          先建一个纸面实验
        </h2>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          这不是回测，也不是荐股。它每天生成可追溯的决策卡，用虚拟资金按固定规则模拟买卖，再用真实行情逐日对账。
        </p>

        <form className="mt-5" onSubmit={(event) => void submit(event)}>
          <div>
            <label className="ck-label" htmlFor="paper-name">实验名称</label>
            <Input
              id="paper-name"
              className="text-base md:text-sm"
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <fieldset className="mt-4">
            <legend className="ck-label">虚拟初始资金</legend>
            <div className="mt-1 grid gap-2 sm:grid-cols-3">
              {CASH_TIERS.map((tier) => {
                const selected = cash === tier.cents
                return (
                  <button
                    key={tier.cents}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCash(tier.cents)}
                    className={cn(
                      'rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border bg-card hover:border-foreground/25',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <b className="text-sm font-semibold">{tier.label}</b>
                      {selected && <Check className="size-4 text-primary" aria-hidden="true" />}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{tier.note}</span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              基准固定为沪深 300 全收益（H00300），现金、沪深 500 与等权自选作为对照。
            </p>
          </fieldset>

          <div className="mt-4 rounded-lg border border-dashed px-3 py-2.5 text-[12px] leading-5 text-muted-foreground">
            当前选择：{formatCny(cash, true)} 虚拟资金 · 计划 250 个交易日 · 冻结协议版本 v1
          </div>

          <div className="ck-form-actions">
            <Button type="submit" disabled={busy}>
              {busy ? '创建中…' : '锁定协议并开始'}
            </Button>
            <span className="ck-inline-meta">创建后如无未结束委托，可暂停或重置。</span>
          </div>
          {error && <p className="ck-form-error" role="alert">{error}</p>}
        </form>
      </section>

      <section className="grid content-start gap-3" aria-label="实验规则">
        {TERMS.map((term) => (
          <div className="ck-card ck-card-pad" key={term.title}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <term.icon className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold">{term.title}</h3>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{term.text}</p>
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
