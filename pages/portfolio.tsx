import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { PortfolioView, SourceHealth } from '@/lib/cockpit/types'
import { formatCny, formatPrice, formatSignedPct } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getPortfolio, getSourceHealth } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { PortfolioEditor, PortfolioRemove } from '@/components/cockpit/portfolio-editor'
import {
  Disclosure,
  EmptyState,
  SectionHeader,
  SourceChip,
} from '@/components/cockpit/bits'

interface PortfolioProps {
  portfolio: PortfolioView | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<PortfolioProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [portfolio, sourceHealth] = await Promise.all([getPortfolio(), getSourceHealth()])
    return { props: serializable({ portfolio, sourceHealth }) }
  } catch (err) {
    console.error('[portfolio]', err instanceof Error ? err.message : err)
    return {
      props: {
        portfolio: null,
        sourceHealth: [],
        loadError: '持仓数据暂时不可用，请稍后刷新。',
      },
    }
  }
}

function pnlTone(value: number): string {
  return value > 0 ? 'ck-up' : value < 0 ? 'ck-down' : 'ck-flat'
}

export default function PortfolioPage({ portfolio, sourceHealth, loadError }: PortfolioProps) {
  const empty = !portfolio || portfolio.positions.length === 0

  return (
    <>
      <Head>
        <title>持仓 · 收盘手记</title>
        <meta name="description" content="个人持仓市值、暴露与风险约束" />
      </Head>
      <CockpitShell
        title="持仓"
        eyebrow="PORTFOLIO · 账本"
        subtitle="先看暴露与集中度，再看单日盈亏。金额按最新收盘价标记，缺价持仓不虚增市值。"
        isDemo={portfolio?.isDemo}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        <Disclosure title="录入或更新持仓" hint="同一代码会覆盖股数与成本" headingLevel={2}>
          <PortfolioEditor />
        </Disclosure>

        {empty ? (
          <EmptyState
            title="还没有可计算的持仓"
            actions={(
              <>
                <Link className="ck-button" href="/watchlist">查看自选</Link>
                <Link className="ck-button ck-button-primary" href="/tasks">运行周度复盘</Link>
              </>
            )}
          >
            展开上方“录入或更新持仓”，填入股票、股数与成本。最新价入库后才会计算市值、浮动盈亏和行业暴露。
          </EmptyState>
        ) : (
          <>
            <section className="ck-section" aria-labelledby="portfolio-summary-title">
              <SectionHeader
                id="portfolio-summary-title"
                title="组合概览"
                detail={`${portfolio.positions.length} 只持仓 · 按最新收盘价计算 · 金额为参考值`}
              />
              <div className="ck-summary-grid">
                <div className="ck-card ck-metric">
                  <span className="ck-metric-label">总市值</span>
                  <p className="ck-metric-value">{formatCny(portfolio.totalValue, true)}</p>
                  <p className="ck-metric-note">缺少最新价的持仓未计入</p>
                </div>
                <div className="ck-card ck-metric">
                  <span className="ck-metric-label">浮动盈亏</span>
                  <p className="ck-metric-value">
                    <span className={pnlTone(portfolio.totalPnl)}>
                      {formatCny(portfolio.totalPnl, true)}
                    </span>
                  </p>
                  <p className="ck-metric-note">
                    {portfolio.totalPnlPct === null ? '成本基数不足' : formatSignedPct(portfolio.totalPnlPct)}
                  </p>
                </div>
                <div className="ck-card ck-metric">
                  <span className="ck-metric-label">前三大集中度</span>
                  <p className="ck-metric-value">{portfolio.concentration.toFixed(1)}%</p>
                  <p className="ck-metric-note">单票超过 40% 时标记为风险</p>
                </div>
              </div>
            </section>

            <section className="ck-section" aria-labelledby="risks-title">
              <SectionHeader
                id="risks-title"
                title="风险与约束"
                detail="只描述组合结构，不替你决定买或卖。"
              />
              {portfolio.risks.length > 0 ? (
                <div className="ck-card ck-risk-list">
                  {portfolio.risks.map((risk) => (
                    <div className={`ck-risk ck-risk-${risk.level}`} key={`${risk.level}-${risk.title}`}>
                      <p className="ck-risk-title">
                        {risk.level === 'critical' ? '严重 · ' : risk.level === 'warn' ? '注意 · ' : '提示 · '}
                        {risk.title}
                      </p>
                      <p className="ck-risk-detail">{risk.detail}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="没有触发结构风险">这不代表持仓安全，只表示当前规则没有发现集中度或缺价问题。</EmptyState>
              )}
            </section>

            <section className="ck-section" aria-labelledby="exposure-title">
              <SectionHeader
                id="exposure-title"
                title="行业暴露"
                detail="按当前市值加权；行业分类来自标的档案。"
              />
              {portfolio.exposure.length === 0 ? (
                <EmptyState title="暂无行业暴露">补齐持仓价格后才能计算行业权重。</EmptyState>
              ) : (
                <div className="ck-card ck-exposure-list">
                  {portfolio.exposure.map((item) => (
                    <div className="ck-exposure-row" key={item.industry}>
                      <div className="ck-exposure-head">
                        <span className="ck-exposure-name">{item.industry}</span>
                        <span className="ck-exposure-value">{item.weight.toFixed(1)}%</span>
                      </div>
                      <div className="ck-exposure-track">
                        <div
                          className="ck-exposure-fill"
                          style={{ width: `${Math.max(0, Math.min(100, item.weight))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="ck-section" aria-labelledby="positions-title">
              <SectionHeader
                id="positions-title"
                title="持仓明细"
                detail="按最新收盘价标记；权重按总市值计算。"
              />
              <div className="ck-positions-cards">
                {portfolio.positions.map((position) => (
                  <article className="ck-card ck-position" key={position.code}>
                    <div className="ck-position-head">
                      <div className="ck-position-id">
                        <div className="ck-position-code">
                          <span>{position.code}</span>
                        </div>
                        <Link className="ck-position-name" href={`/stock/${encodeURIComponent(position.code)}`}>
                          {position.name}
                        </Link>
                        <span className="ck-position-industry">{position.industry}</span>
                      </div>
                      <div className="ck-position-value">
                        {position.price === null ? '缺价' : formatCny(position.marketValue, true)}
                        <span>市值 · 权重 {position.weight.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="ck-position-grid">
                      <div className="ck-position-cell">
                        <span>现价</span>
                        <b>{position.price === null ? '—' : formatPrice(position.price)}</b>
                      </div>
                      <div className="ck-position-cell">
                        <span>成本</span>
                        <b>{formatPrice(position.avgCost)}</b>
                      </div>
                      <div className="ck-position-cell">
                        <span>浮动盈亏</span>
                        <b className={position.price === null ? 'ck-flat' : pnlTone(position.pnl)}>
                          {position.price === null ? '—' : formatCny(position.pnl, true)}
                        </b>
                        {position.price !== null && position.pnlPct !== null && (
                          <small className={pnlTone(position.pnl)}>{formatSignedPct(position.pnlPct)}</small>
                        )}
                      </div>
                      <div className="ck-position-cell">
                        <span>股数</span>
                        <b>{position.shares.toLocaleString('zh-CN')}</b>
                      </div>
                    </div>
                    <div className="ck-position-foot">
                      <SourceChip source={position.source} />
                      <PortfolioRemove code={position.code} name={position.name} />
                    </div>
                  </article>
                ))}
              </div>

              <div
                className="ck-table-wrap ck-positions-table"
                role="region"
                aria-label="持仓明细，可横向滚动"
                tabIndex={0}
              >
                <table className="ck-table">
                  <thead>
                    <tr>
                      <th scope="col">标的</th>
                      <th scope="col">行业</th>
                      <th scope="col" className="ck-num">股数</th>
                      <th scope="col" className="ck-num">成本</th>
                      <th scope="col" className="ck-num">现价</th>
                      <th scope="col" className="ck-num">市值</th>
                      <th scope="col" className="ck-num">浮动盈亏</th>
                      <th scope="col" className="ck-num">权重</th>
                      <th scope="col">来源</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {portfolio.positions.map((position) => (
                      <tr key={position.code}>
                        <td>
                          <Link className="ck-table-code" href={`/stock/${encodeURIComponent(position.code)}`}>
                            {position.code}
                          </Link>
                          <span className="ck-table-sub">{position.name}</span>
                        </td>
                        <td>{position.industry}</td>
                        <td className="ck-num">{position.shares.toLocaleString('zh-CN')}</td>
                        <td className="ck-num">{formatPrice(position.avgCost)}</td>
                        <td className="ck-num">{position.price === null ? '缺价' : formatPrice(position.price)}</td>
                        <td className="ck-num">{position.marketValue ? formatCny(position.marketValue, true) : '—'}</td>
                        <td className="ck-num">
                          {position.price === null ? (
                            '—'
                          ) : (
                            <>
                              <span className={pnlTone(position.pnl)}>
                                {formatCny(position.pnl, true)}
                              </span>
                              {position.pnlPct !== null && (
                                <span className="ck-table-sub">{formatSignedPct(position.pnlPct)}</span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="ck-num">{position.weight.toFixed(2)}%</td>
                        <td><SourceChip source={position.source} /></td>
                        <td><PortfolioRemove code={position.code} name={position.name} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </CockpitShell>
    </>
  )
}
