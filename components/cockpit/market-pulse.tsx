import type { Breadth, MarketIndex, Turnover } from '@/lib/cockpit/types'
import { formatPrice, formatYi } from '@/lib/cockpit/format'
import {
  DeltaValue,
  SourceChip,
  Sparkline,
} from './bits'

function breadthSegments(breadth: Breadth) {
  return [
    { key: 'up', value: breadth.up, label: '上涨', tone: 'ck-up' },
    { key: 'flat', value: breadth.flat, label: '平盘', tone: 'ck-flat' },
    { key: 'down', value: breadth.down, label: '下跌', tone: 'ck-down' },
  ].filter((segment) => segment.value > 0)
}

/** 首屏快照：只留收盘后最该先看到的三个指数、涨跌家数与成交额。 */
export function MarketSnapshot({
  indices,
  breadth,
  turnover,
}: {
  indices: MarketIndex[]
  breadth: Breadth
  turnover: Turnover
}) {
  const total = breadth.up + breadth.flat + breadth.down
  const limitsKnown = breadth.limitUpDownAvailable !== false
  const segments = breadthSegments(breadth)
  const quoteSource = indices.find((index) => index.source)?.source
  const sources = [quoteSource, breadth.source, turnover.source]
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
    .filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index)

  return (
    <div className="ck-snapshot" aria-label="收盘行情快照">
      <div className="ck-snapshot-indices">
        {indices.map((index) => (
          <div className="ck-snapshot-index" key={index.code}>
            <span className="ck-snapshot-name">
              {index.name}
              <code>{index.code}</code>
            </span>
            <strong>{formatPrice(index.close)}</strong>
            <DeltaValue value={index.changePct} />
          </div>
        ))}
      </div>
      <div className="ck-snapshot-stats">
        <div>
          <span className="ck-snapshot-label">涨跌家数</span>
          <div className="ck-snapshot-breadth-line">
            <span
              className="ck-snapshot-bar"
              role="img"
              aria-label={`上涨 ${breadth.up} 家，平盘 ${breadth.flat} 家，下跌 ${breadth.down} 家`}
            >
              {segments.map((segment) => (
                <span
                  className={`ck-snapshot-seg ${segment.tone}`}
                  key={segment.key}
                  style={{ flex: `${segment.value} 0 0%` }}
                />
              ))}
            </span>
            <span className="ck-snapshot-breadth-nums">
              <b className="ck-up">↑ {breadth.up.toLocaleString('zh-CN')}</b>
              <span className="ck-sep">/</span>
              <b className="ck-down">↓ {breadth.down.toLocaleString('zh-CN')}</b>
            </span>
          </div>
          <span className="ck-snapshot-breakdown">
            平盘 {breadth.flat.toLocaleString('zh-CN')} · 全市场 {total.toLocaleString('zh-CN')} 家
            {limitsKnown && ` · 涨停 ${breadth.limitUp} / 跌停 ${breadth.limitDown}`}
          </span>
        </div>
        <div className="ck-snapshot-turnover">
          <span className="ck-snapshot-label">两市成交</span>
          <strong>{formatYi(turnover.value)}</strong>
          <DeltaValue value={turnover.changePct} />
        </div>
      </div>
      {sources.length > 0 && (
        <div className="ck-snapshot-source">
          <span>行情来源</span>
          {sources.map((source) => <SourceChip source={source} key={source.id} />)}
          <span>· 收盘后更新</span>
        </div>
      )}
    </div>
  )
}

function BreadthBlock({ breadth }: { breadth: Breadth }) {
  const total = breadth.up + breadth.flat + breadth.down
  const limitsKnown = breadth.limitUpDownAvailable !== false
  const segments = breadthSegments(breadth)
  return (
    <div className="ck-card ck-pulse-card">
      <div className="ck-pulse-head">
        <span className="ck-pulse-title">涨跌分布</span>
        <span className="ck-pulse-note">全市场 · {total.toLocaleString('zh-CN')} 家</span>
      </div>
      <div
        className="ck-breadth-bar"
        role="img"
        aria-label={`上涨 ${breadth.up} 家，平盘 ${breadth.flat} 家，下跌 ${breadth.down} 家`}
      >
        {segments.map((segment) => (
          <span
            className={`ck-breadth-seg ${segment.tone}`}
            key={segment.key}
            style={{ flex: `${segment.value} 0 0%` }}
            title={`${segment.label} ${segment.value} 家`}
          />
        ))}
      </div>
      <div className="ck-breadth-legend">
        {segments.map((segment) => (
          <div className="ck-breadth-item" key={segment.key}>
            <span className="ck-breadth-label">
              <i className={`ck-breadth-dot ${segment.tone}`} aria-hidden="true" />
              {segment.label}
            </span>
            <span className="ck-breadth-value">{segment.value.toLocaleString('zh-CN')}</span>
            <span className="ck-breadth-sub">
              {total > 0 ? `${((segment.value / total) * 100).toFixed(1)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
      <div className="ck-stat-line">
        <div className="ck-stat">
          <span className="ck-stat-label">涨停</span>
          <span className="ck-stat-value ck-up" title={limitsKnown ? undefined : '本次未取到涨跌停统计'}>
            {limitsKnown ? breadth.limitUp : '—'}
          </span>
        </div>
        <div className="ck-stat">
          <span className="ck-stat-label">跌停</span>
          <span className="ck-stat-value ck-down" title={limitsKnown ? undefined : '本次未取到涨跌停统计'}>
            {limitsKnown ? breadth.limitDown : '—'}
          </span>
        </div>
        <div className="ck-stat">
          <span className="ck-stat-label">平盘</span>
          <span className="ck-stat-value">{breadth.flat}</span>
        </div>
      </div>
    </div>
  )
}

function TurnoverBlock({ turnover }: { turnover: Turnover }) {
  return (
    <div className="ck-card ck-pulse-card">
      <div className="ck-pulse-head">
        <span className="ck-pulse-title">两市成交</span>
        <span className="ck-pulse-note">较前一交易日</span>
      </div>
      <div className="ck-stat">
        <span className="ck-stat-value" style={{ fontSize: 23 }}>{formatYi(turnover.value)}</span>
        <span className="ck-stat-note">
          <DeltaValue value={turnover.changePct} />
        </span>
      </div>
      <div className="ck-stat-line">
        <div className="ck-stat">
          <span className="ck-stat-label">成交额口径</span>
          <span className="ck-stat-note">沪深两市合计，单位亿元</span>
        </div>
      </div>
    </div>
  )
}

export function MarketPulse({
  indices,
  breadth,
  turnover,
}: {
  indices: MarketIndex[]
  breadth: Breadth
  turnover: Turnover
}) {
  const quoteSource = indices.find((index) => index.source)?.source
  const sources = [quoteSource, breadth.source, turnover.source]
    .filter((source): source is NonNullable<typeof source> => Boolean(source))
    .filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index)

  return (
    <details className="ck-card ck-market-details">
      <summary>
        <span className="ck-market-summary-title">行情、广度与成交明细</span>
        <span className="ck-market-summary-meta">指数走势 · 涨跌停 · 数据表</span>
      </summary>
      <div className="ck-market-body">
        <div className="ck-index-grid">
          {indices.map((index) => (
            <article className="ck-card ck-index-card" key={index.code}>
              <div className="ck-index-head">
                <span className="ck-index-name">{index.name}</span>
                <span className="ck-index-code">{index.code}</span>
              </div>
              <p className="ck-index-value">{formatPrice(index.close)}</p>
              <div className="ck-index-foot">
                <DeltaValue value={index.changePct} />
                <span className="ck-index-spark">
                  <Sparkline
                    values={index.sparkline}
                    label={`${index.name}近 ${index.sparkline.length} 个交易日收盘走势，最新 ${formatPrice(index.close)}，涨跌幅 ${index.changePct.toFixed(2)}%`}
                  />
                </span>
              </div>
            </article>
          ))}
        </div>
        <div className="ck-pulse-grid">
          <BreadthBlock breadth={breadth} />
          <TurnoverBlock turnover={turnover} />
        </div>
        {indices.some((index) => index.sparkline.length > 1) && (
          <details className="ck-price-table ck-index-table">
            <summary>查看指数走势数据表（图表的数据视图）</summary>
            <div className="ck-table-wrap" role="region" aria-label="指数走势数据表，可横向滚动" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">指数</th>
                    <th scope="col">最新收盘</th>
                    <th scope="col">涨跌幅</th>
                    {Array.from({ length: 5 }, (_, position) => (
                      <th scope="col" className="ck-num" key={position}>T-{4 - position}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {indices.map((index) => {
                    const recent = index.sparkline.slice(-5)
                    return (
                      <tr key={index.code}>
                        <th scope="row">{index.name}</th>
                        <td className="ck-num">{formatPrice(index.close)}</td>
                        <td className="ck-num"><DeltaValue value={index.changePct} /></td>
                        {Array.from({ length: 5 }, (_, position) => {
                          const offset = 5 - recent.length
                          const value = position < offset ? null : recent[position - offset]
                          return (
                            <td className="ck-num" key={position}>
                              {value === null ? '—' : formatPrice(value)}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {sources.length > 0 && (
          <div className="ck-inline-meta" style={{ marginTop: 9 }}>
            <span>来源</span>
            {sources.map((source) => <SourceChip source={source} key={source.id} />)}
          </div>
        )}
      </div>
    </details>
  )
}
