/**
 * Next 的 getServerSideProps 不接受 undefined（会直接 500），而领域类型大量使用
 * 可选字段。页面出口统一剥掉 undefined，数组里的 undefined 变成 null。
 */
export function serializable<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : serializable(item))) as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = serializable(item)
    }
    return out as T
  }
  return value
}
