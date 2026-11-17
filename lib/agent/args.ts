/** 工具参数安全转换：undefined/null/空串 → 默认值；NaN → 默认值；合法数字原样返回。
 *  不用 `Number(x) || fallback`——`Number("0")` 为 0（falsy）会被误吞为默认值。 */
export function numArg(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 数字参数 → [min, max] 内的整数。 */
export function intArg(v: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(numArg(v, fallback))));
}
