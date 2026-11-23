import { fetchMarketData, saveMarketData, runBacktest } from '../../../lib/market';
import { assertCronAuth } from '../../../lib/cronAuth';
import { defaultBatchId, withPipelineRun, isJobFresh } from '../../../lib/pipeline';
import { isChinaMarketOpen } from '../../../lib/china-calendar';
import { todayShanghai } from '../../../lib/cockpit/format';

/**
 * Phase 4: Fetch market data + run backtest.
 * GET /api/cron/fetch-market?batch=<optional>
 *
 * 节流：回测是全量重建（30 天窗口 × 全市场指数，单次数万行读取）。
 * 调度频率（QStash 30 分钟）远高于数据需要，距上次成功 < 6h 直接跳过，
 * 避免行读取配额被高频调度推爆。行情数据本身 6h 更新一次也足够。
 * 周末、法定节假日与调休补班日不跑行情；新闻/政策分析走独立 cron，不受影响。
 */
export default async function handler(req, res) {
  if (!await assertCronAuth(req, res)) return;

  try {
    const tradeDate = todayShanghai();
    if (!await isChinaMarketOpen(tradeDate)) {
      return res.status(200).json({ ok: true, skipped: 'not_trading_day', tradeDate });
    }
    if (await isJobFresh('fetch-market', 6 * 3600 * 1000)) {
      return res.status(200).json({ ok: true, skipped: 'fresh (within 6h)' });
    }
    const batchId = typeof req.query.batch === 'string' ? req.query.batch : defaultBatchId();
    const result = await withPipelineRun(
      'fetch-market',
      batchId,
      async () => {
        const rows = await fetchMarketData();
        const saved = await saveMarketData(rows);
        // 全部失败时是 0 行；先短路再做全量回测，别为一次上游故障白跑 30 天重建
        // （失败不记成功，调度会重试，所以也不会被 6h 节流挡住）
        if (saved === 0) throw new Error('no market rows fetched (upstream unavailable)');
        const btResult = await runBacktest();
        return { market_rows: saved, backtest_pairs: btResult.pairs };
      },
      (r) => r.market_rows + r.backtest_pairs
    );
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('[cron/fetch-market] Error:', error);
    res.status(500).json({ error: 'Market data fetch failed' });
  }
}
