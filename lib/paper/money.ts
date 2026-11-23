/** 整数分/整数股的取整工具；所有除法显式指定舍入方向。 */

export const YUAN_CENTS = 100
export const PPM = 1_000_000

/** a、b 均为非负整数。 */
export function ceilDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0) {
    throw new Error(`ceilDiv 参数非法: ${a}/${b}`)
  }
  return Math.floor((a + b - 1) / b)
}

export function floorDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0) {
    throw new Error(`floorDiv 参数非法: ${a}/${b}`)
  }
  return Math.floor(a / b)
}

/** 四舍五入到整数（用于涨跌停价、金额取整），只在 .5 处向上。 */
export function roundHalfUpDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0 || a < 0) {
    throw new Error(`roundHalfUpDiv 参数非法: ${a}/${b}`)
  }
  return Math.floor((a + Math.floor(b / 2)) / b)
}

/** 按 ppm 计费，费用一律向上取整（宁可高估成本）。 */
export function ppmCeil(amountCents: number, ppm: number): number {
  if (!Number.isSafeInteger(amountCents) || !Number.isSafeInteger(ppm) || amountCents < 0 || ppm < 0) {
    throw new Error(`ppmCeil 参数非法: ${amountCents}×${ppm}ppm`)
  }
  return ceilDiv(amountCents * ppm, PPM)
}

/** 按基准点计算比例，用于展示与风控，不用于记账。 */
export function bpOf(partCents: number, wholeCents: number): number {
  if (!wholeCents) return 0
  return Math.round((partCents * 10_000) / wholeCents)
}
