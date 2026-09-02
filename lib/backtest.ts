/**
 * P2.3 回测可信度分层。
 *
 * 可信度由「方向样本数」(多/空事件,即命中率分母)决定——总事件含中性/混合,
 * 用它衡量命中率精度会虚高(如总事件 45 但方向样本仅 2 → 100% 无提示):
 * - sufficient（≥30）「样本充足」：展示数字 + 正常配色
 * - reference（10–29）「仅供参考」：展示数字 + 浅提示（~ 前缀）
 * - accumulating（<10）「数据积累中」：不展示胜率/收益数字，只显示行业名 + 进度
 * 调用方传入方向样本数(directional_count ?? samples 兜底遗留行)。
 */
export type BacktestTier = 'sufficient' | 'reference' | 'accumulating';

export const TIER_MIN_SAMPLES = 30;
export const TIER_REFERENCE_MIN = 10;

export function getBacktestTier(samples: number): BacktestTier {
  if (samples >= TIER_MIN_SAMPLES) return 'sufficient';
  if (samples >= TIER_REFERENCE_MIN) return 'reference';
  return 'accumulating';
}

export const TIER_LABELS: Record<BacktestTier, string> = {
  sufficient: '样本充足',
  reference: '仅供参考',
  accumulating: '数据积累中',
};

/** accumulating 档的进度文案（如 "多空样本 7/10"，以方向样本数为准）。 */
export function tierProgress(samples: number): string {
  return `多空样本 ${Math.max(0, samples)}/${TIER_REFERENCE_MIN}`;
}

/** 数字是否应展示（accumulating 不展示收益/胜率数字）。 */
export function shouldShowNumbers(tier: BacktestTier): boolean {
  return tier !== 'accumulating';
}
