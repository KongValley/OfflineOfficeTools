// 页码解析:统一 PDF 工具的范围输入语义
// 全角数字/中文逗号/波浪号长横 归一化;越界、倒序、空输入一律 null

function normalize(input) {
  return String(input)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、;；]/g, ',')
    .replace(/[~～—–－]/g, '-')
    .trim()
}

// 返回升序去重的 0-based 页索引;输入非法返回 null
export function parsePageRange(input, totalPages) {
  const text = normalize(input)
  if (!text) return null
  const pages = new Set()
  for (const part of text.split(',')) {
    const range = part.trim()
    if (!range) return null
    const m = /^(\d+)(?:-(\d+))?$/.exec(range)
    if (!m) return null
    const start = Number(m[1])
    const end = m[2] == null ? start : Number(m[2])
    if (start < 1 || end < 1 || start > end || end > totalPages) return null
    for (let p = start; p <= end; p += 1) pages.add(p - 1)
  }
  return [...pages].sort((a, b) => a - b)
}

// 把页索引切成连续段,如 [0,1,2,4,5] → [[0,1,2],[4,5]]
export function splitPageSegments(pages) {
  const segments = []
  let current = []
  for (const p of pages) {
    if (current.length && p !== current[current.length - 1] + 1) {
      segments.push(current)
      current = []
    }
    current.push(p)
  }
  if (current.length) segments.push(current)
  return segments
}

// 0-based 页索引 → 范围文本,升序去重并把连续段压缩成 a-b
export function formatPageRange(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
    parts.push(i === j ? String(sorted[i] + 1) : `${sorted[i] + 1}-${sorted[j] + 1}`)
    i = j + 1
  }
  return parts.join(',')
}
