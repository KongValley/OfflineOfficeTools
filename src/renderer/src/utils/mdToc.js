// Markdown 目录:扫描标题、生成 slug、插入/更新 TOC、给 markdown-it 标题加 id。
// 纯 ESM 无 import;标记用链接引用定义,markdown-it 会静默丢弃,不会出现在预览里。

export const TOC_START = '[//]: # (oot-toc)'
export const TOC_END = '[//]: # (oot-toc-end)'

// 去掉标题里的行内 Markdown,得到纯文本(用于目录文字和 slug)
export function plainHeadingText(raw) {
  return String(raw ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 中文按字保留,英文转小写,空格转连字符,标点去掉
export function slugifyHeading(text) {
  const plain = plainHeadingText(text).toLowerCase()
  const slug = plain
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'section'
}

function uniqueSlug(base, used) {
  let slug = base
  let n = 0
  while (used.has(slug)) {
    n += 1
    slug = `${base}-${n}`
  }
  used.add(slug)
  return slug
}

function splitSource(source) {
  const text = String(source ?? '')
  const eol = (text.match(/\r\n|\r|\n/) || ['\n'])[0]
  return { lines: text.split(/\r\n|\r|\n/), eol }
}

// 跳过 YAML front matter,返回正文起始行号
function bodyStart(lines) {
  if (!lines.length || lines[0].trim() !== '---') return 0
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') return i + 1
  }
  return 0
}

// markdown-it 没有 front matter 规则,不剥离的话 `title: x` 会被下一行 `---` 当成 setext 标题
export function stripFrontMatter(source) {
  const { lines, eol } = splitSource(source)
  const start = bodyStart(lines)
  return start > 0 ? lines.slice(start).join(eol) : String(source ?? '')
}

// 扫描 # 标题,跳过围栏代码块;返回 [{level,text,slug}]
export function scanHeadings(source) {
  const { lines } = splitSource(source)
  const start = bodyStart(lines)
  const headings = []
  const used = new Set()
  let fence = null
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        fence = { char: open[1][0], len: open[1].length }
        continue
      }
      const m = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line)
      if (m) {
        const text = plainHeadingText(m[2])
        if (text) {
          headings.push({ level: m[1].length, text, slug: uniqueSlug(slugifyHeading(text), used) })
        }
      }
    } else {
      const close = new RegExp(`^ {0,3}${fence.char}{${fence.len},}\\s*$`).test(line)
      if (close) fence = null
    }
  }
  return headings
}

// 生成目录列表:相对最小层级缩进 2 个空格
export function buildTocMarkdown(headings) {
  if (!Array.isArray(headings) || !headings.length) return ''
  const min = Math.min(...headings.map((h) => h.level))
  return headings
    .map((h) => {
      const indent = '  '.repeat(Math.max(0, h.level - min))
      const label = String(h.text).replace(/([\[\]])/g, '\\$1')
      return `${indent}- [${label}](#${h.slug})`
    })
    .join('\n')
}

// 从 start 行起吃掉紧邻的目录列表(空行 / 列表项 / 缩进续行),返回块最后一行号
function tocBlockEnd(lines, start) {
  let end = start
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*(?:[-*+]\s|$)/.test(lines[i])) end = i
    else break
  }
  return end
}

// 已有标记则替换中间内容;否则插到 front matter 之后(或文首)
export function insertOrUpdateToc(source) {
  const headings = scanHeadings(source)
  if (!headings.length) throw new Error('没有找到 Markdown 标题')
  const { lines, eol } = splitSource(source)
  const toc = buildTocMarkdown(headings)
  // 标记与列表之间留空行,否则结束标记会被当成列表项的续行
  const block = [TOC_START, '', ...toc.split('\n'), '', TOC_END]

  const startIndex = lines.findIndex((l) => l.trim() === TOC_START)
  const endIndex = startIndex >= 0
    ? lines.findIndex((l, i) => i > startIndex && l.trim() === TOC_END)
    : -1
  if (startIndex >= 0) {
    // 只有起始标记时,连同它下面遗留的列表一起替换,避免留下孤立标记
    const stop = endIndex > startIndex ? endIndex : tocBlockEnd(lines, startIndex)
    lines.splice(startIndex, stop - startIndex + 1, ...block)
  } else {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === TOC_END) lines.splice(i, 1)
    }
    const at = bodyStart(lines)
    const insert = at > 0 ? ['', ...block, ''] : [...block, '']
    lines.splice(at, 0, ...insert)
  }
  return lines.join(eol)
}

// markdown-it 核心规则:按出现顺序给 heading_open 加 id,与 TOC 的 slug 完全一致
export function assignHeadingIds(tokens) {
  const used = new Set()
  const headings = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'heading_open') continue
    const inline = tokens[i + 1]
    const raw = inline && inline.type === 'inline' ? inline.content : ''
    const text = plainHeadingText(raw)
    if (!text) continue
    const level = Number(String(token.tag || '').replace(/^h/, '')) || 1
    const slug = uniqueSlug(slugifyHeading(text), used)
    token.attrSet('id', slug)
    headings.push({ level, text, slug })
  }
  return headings
}
