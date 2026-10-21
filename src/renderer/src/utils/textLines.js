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

// ---------- 文本增强:统计与逐行处理 ----------

// 只给非空行加前缀/后缀,空行原样保留
export const prefixSuffixLines = (text, prefix = '', suffix = '') =>
  transformLines(text, (ls) => ls.map((l) => (l.trim() ? `${prefix}${l}${suffix}` : l)))

// 只给非空行编号,空行不占号
export function addLineNumbers(text, start = 1, separator = '. ') {
  const first = Math.trunc(Number(start))
  if (!Number.isInteger(first) || first < 0 || first > 999999) {
    throw new Error('起始行号需在 0–999999 之间')
  }
  let n = first
  return transformLines(text, (ls) =>
    ls.map((l) => {
      if (!l.trim()) return l
      const out = `${n}${separator}${l}`
      n += 1
      return out
    })
  )
}

// upper / lower / title;title 只处理英文单词,中文和数字不动
export function changeCase(text, mode) {
  if (mode === 'upper') return String(text).toUpperCase()
  if (mode === 'lower') return String(text).toLowerCase()
  if (mode === 'title') {
    return transformLines(text, (ls) =>
      ls.map((l) => l.replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()))
    )
  }
  throw new Error('未知的大小写模式')
}

// 半角 ASCII → 全角,半角空格 → 全角空格
export const toFullWidth = (text) =>
  String(text).replace(/[ -~]/g, (c) =>
    c === ' ' ? '　' : String.fromCharCode(c.charCodeAt(0) + 0xfee0)
  )

// 全角 ASCII / 全角空格 → 半角
export const toHalfWidth = (text) =>
  String(text).replace(/[　！-～]/g, (c) =>
    c === '　' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  )

// 逐行去首尾空白,保留空行与换行风格(与 trimLineList 不同,不删空行)
export const trimLineSides = (text) => transformLines(text, (ls) => ls.map((l) => l.trim()))

// 按码点计数,避免 [...str] 在 8MB 文本上分配百万级数组
function countCodePoints(text) {
  let count = 0
  for (const _ of text) count += 1
  return count
}

// 字数统计:字数不含换行;非空白字符去掉所有空白;英文单词按字母/数字串计
export function textStats(text) {
  const s = String(text ?? '')
  if (!s) {
    return { chars: 0, charsNoSpace: 0, cjk: 0, words: 0, lines: 0, nonEmptyLines: 0, paragraphs: 0 }
  }
  const noEol = s.replace(/\r\n|\r|\n/g, '')
  const lines = s.split(/\r\n|\r|\n/)
  const cjk = (s.match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length
  const words = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length
  const paragraphs = s.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).filter((p) => p.trim()).length
  return {
    chars: countCodePoints(noEol),
    charsNoSpace: countCodePoints(s.replace(/\s/gu, '')),
    cjk,
    words,
    lines: lines.length,
    nonEmptyLines: lines.filter((l) => l.trim()).length,
    paragraphs
  }
}
