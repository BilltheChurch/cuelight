/**
 * Writes storyboards the way people format them by hand: an object or array stays on one line
 * when it fits, otherwise it opens up one entry per line. Key order is kept as is.
 */
export function formatJson(value: unknown, width = 140): string {
  const entries = (v: object) => Object.entries(v).filter(([, x]) => x !== undefined)
  const inline = (v: unknown): string => {
    if (Array.isArray(v)) return v.length ? '[' + v.map(inline).join(', ') + ']' : '[]'
    if (v && typeof v === 'object') {
      const e = entries(v)
      return e.length ? '{ ' + e.map(([k, x]) => JSON.stringify(k) + ': ' + inline(x)).join(', ') + ' }' : '{}'
    }
    return JSON.stringify(v) ?? 'null'
  }
  const block = (v: unknown, indent: string, used: number): string => {
    const one = inline(v)
    if (v === null || typeof v !== 'object' || indent.length + used + one.length <= width) return one
    const inner = indent + '  '
    if (Array.isArray(v)) return '[\n' + v.map((x) => inner + block(x, inner, 0)).join(',\n') + '\n' + indent + ']'
    const lines = entries(v).map(([k, x]) => {
      const key = JSON.stringify(k) + ': '
      return inner + key + block(x, inner, key.length)
    })
    return '{\n' + lines.join(',\n') + '\n' + indent + '}'
  }
  return block(value, '', 0) + '\n'
}
