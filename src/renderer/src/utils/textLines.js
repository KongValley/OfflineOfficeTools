// 行处理保持源文件的换行风格与末尾换行;没有换行符时默认 CRLF
const EOL_RE = /\r\n|\r|\n/
const ENDS_WITH_EOL = /(?:\r\n|\r|\n)$/

export function detectEol(text) {
  const m = text.match(EOL_RE)
  return m ? m[0] : '\r\n'
}

export function transformLines(text, fn) {
  const eol = detectEol(text)
  const trailing = ENDS_WITH_EOL.test(text)
  const lines = text.split(EOL_RE)
  if (trailing) lines.pop()
  const out = fn(lines)
  return out.join(eol) + (trailing && out.length ? eol : '')
}

export const dedupeLines = (text) => transformLines(text, (ls) => [...new Set(ls)])
export const sortLineList = (text) =>
  transformLines(text, (ls) => [...ls].sort((a, b) => a.localeCompare(b, 'zh')))
export const trimLineList = (text) =>
  transformLines(text, (ls) => ls.map((l) => l.trim()).filter(Boolean))
