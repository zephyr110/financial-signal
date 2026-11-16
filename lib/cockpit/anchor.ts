/** 自选卡片锚点：个股页的「返回自选」据此回到并定位到对应行。 */
export function watchAnchorId(code: string): string {
  return `watch-${code.replace(/[^A-Za-z0-9_-]/g, '-')}`
}
