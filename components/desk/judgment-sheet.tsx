import { AlertTriangle, ArrowUpRight, FileSearch, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatSignedPct } from '@/lib/cockpit/format'
import type { JudgmentView } from '@/lib/desk/types'
import { ConfidenceBadge, StanceBadge } from './ui'

export function JudgmentSheet({
  judgment,
  onClose,
  onDeepDive,
}: {
  judgment: JudgmentView | null
  onClose: () => void
  onDeepDive: (judgment: JudgmentView) => void
}) {
  return (
    <Sheet open={Boolean(judgment)} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        {judgment && (
          <>
            <SheetHeader className="relative shrink-0 px-5 py-4 after:pointer-events-none after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-border/60 after:content-['']">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
                <span className="tracking-wide">{judgment.kind === 'market' ? '市场判断' : judgment.industry || '行业判断'}</span>
                <StanceBadge stance={judgment.stance} />
                <ConfidenceBadge confidence={judgment.confidence} />
                <span className="tabular-nums">评分 {judgment.score.toFixed(1)}</span>
              </div>
              <SheetTitle className="pr-8 text-[17px] font-semibold leading-6 tracking-tight">{judgment.headline}</SheetTitle>
              <SheetDescription className="line-clamp-3 text-[13px] leading-5">{judgment.summary}</SheetDescription>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">
                  <TrendingUp className="size-3.5" />核心驱动
                </h3>
                {judgment.drivers.length ? (
                  <ul className="space-y-1.5">
                    {judgment.drivers.map((driver) => (
                      <li key={driver} className="flex gap-2 text-sm leading-6">
                        <ArrowUpRight className="mt-1 size-3.5 shrink-0 text-chart-3" />
                        <span>{driver}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">未记录驱动因素。</p>}
              </section>

              <section className="space-y-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">
                  <AlertTriangle className="size-3.5" />主要风险
                </h3>
                {judgment.risks.length ? (
                  <ul className="space-y-1.5">
                    {judgment.risks.map((risk) => (
                      <li key={risk} className="flex gap-2 text-sm leading-6">
                        <AlertTriangle className="mt-1 size-3.5 shrink-0 text-chart-5" />
                        <span>{risk}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">未记录风险项。</p>}
              </section>

              <section className="space-y-2">
                <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground">证据（{judgment.evidence.length}）</h3>
                {judgment.evidence.length ? (
                  <ul className="rounded-lg bg-muted/25">
                    {judgment.evidence.map((item) => (
                      <li key={item.id} className="relative flex items-start justify-between gap-3 px-3 py-2 text-xs leading-5 after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{item.label}</p>
                          {item.value && <p className="line-clamp-2 text-muted-foreground">{item.value}</p>}
                          {item.sourceName && <p className="text-[11px] text-muted-foreground">{item.sourceName}{item.asOf ? ` · ${item.asOf}` : ''}</p>}
                        </div>
                        <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">{item.kind}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-muted-foreground">暂无证据条目。</p>}
              </section>

              {judgment.evaluations.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground">事后验证</h3>
                  <div className="overflow-hidden rounded-lg bg-muted/25">
                    <table className="w-full text-xs">
                      <thead className="text-[11px] text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">窗口</th>
                          <th className="px-3 py-2 text-right font-medium">区间收益</th>
                          {judgment.evaluations.some((evaluation) => evaluation.benchmarkPct != null) && (
                            <th className="px-3 py-2 text-right font-medium">基准</th>
                          )}
                          <th className="px-3 py-2 text-right font-medium">方向</th>
                        </tr>
                      </thead>
                      <tbody>
                        {judgment.evaluations.map((evaluation) => (
                          <tr key={`${evaluation.horizonDays}-${evaluation.evalDate}`} className="border-t border-border/50">
                            <td className="px-3 py-2">{evaluation.horizonDays} 日</td>
                            <td className={`px-3 py-2 text-right tabular-nums ${(evaluation.returnPct ?? 0) >= 0 ? 'text-chart-3' : 'text-chart-2'}`}>
                              {evaluation.returnPct == null ? '—' : formatSignedPct(evaluation.returnPct)}
                            </td>
                            {judgment.evaluations.some((item) => item.benchmarkPct != null) && (
                              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                {evaluation.benchmarkPct == null ? '—' : formatSignedPct(evaluation.benchmarkPct)}
                              </td>
                            )}
                            <td className="px-3 py-2 text-right text-muted-foreground">{evaluation.hit ? '命中' : '未中'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>交易日 {judgment.tradeDate}</span>
                <span>版本 v{judgment.version}</span>
                <span>{judgment.status === 'open' ? '有效' : judgment.status === 'expired' ? '已过期' : '已被替代'}</span>
                {judgment.isDemo && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">示例数据</Badge>}
              </div>
            </div>

            <div className="relative shrink-0 px-5 py-3 before:pointer-events-none before:absolute before:inset-x-5 before:top-0 before:h-px before:bg-border/60 before:content-['']">
              <Button size="sm" onClick={() => onDeepDive(judgment)}>
                <FileSearch className="size-4" />深挖该判断
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
