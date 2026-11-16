export interface PaletteFilterable {
  label: string
  group: string
  keywords?: string[]
}

/** 空格分词后每个词都要命中，中文串直接做子串匹配。 */
export function filterPaletteCommands<T extends PaletteFilterable>(commands: readonly T[], query: string): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return [...commands]
  return commands.filter((command) => {
    const haystack = [command.label, command.group, ...(command.keywords ?? [])].join(' ').toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

export function nextIndex(current: number, length: number, delta: number): number {
  if (length <= 0) return -1
  return (current + delta + length) % length
}

export function groupPaletteCommands<T extends { group: string }>(commands: readonly T[]): Array<{ group: string; items: T[] }> {
  const groups: Array<{ group: string; items: T[] }> = []
  for (const command of commands) {
    const last = groups[groups.length - 1]
    if (last?.group === command.group) last.items.push(command)
    else groups.push({ group: command.group, items: [command] })
  }
  return groups
}
