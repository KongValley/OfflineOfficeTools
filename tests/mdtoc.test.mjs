import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MarkdownIt = require('markdown-it')

function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const {
  TOC_START,
  TOC_END,
  plainHeadingText,
  slugifyHeading,
  scanHeadings,
  buildTocMarkdown,
  insertOrUpdateToc,
  assignHeadingIds,
  stripFrontMatter
} = await loadEsm('../src/renderer/src/utils/mdToc.js')

function renderWithIds(src) {
  const md = new MarkdownIt()
  md.core.ruler.push('heading_ids', (state) => assignHeadingIds(state.tokens))
  return md.render(src)
}

test('slug 保留中文、去标点并处理重复', () => {
  assert.equal(slugifyHeading('Hello World!'), 'hello-world')
  assert.equal(slugifyHeading('中文 标题'), '中文-标题')
  assert.equal(slugifyHeading('1.1 背景'), '11-背景')
  assert.equal(slugifyHeading('C#'), 'c')
  assert.equal(slugifyHeading('!!!'), 'section')
  assert.equal(plainHeadingText('**粗体** 与 [链接](x)'), '粗体 与 链接')
})

const SOURCE = `---
title: 示例
---
# 标题

## 1.1 背景

\`\`\`js
# 代码里的井号不是标题
\`\`\`

## 标题

### 细节 ###
`

test('扫描标题跳过 front matter 与围栏代码,重复加后缀', () => {
  const headings = scanHeadings(SOURCE)
  assert.deepEqual(headings.map((h) => h.level), [1, 2, 2, 3])
  assert.deepEqual(headings.map((h) => h.slug), ['标题', '11-背景', '标题-1', '细节'])
  assert.deepEqual(headings.map((h) => h.text), ['标题', '1.1 背景', '标题', '细节'])
})

test('目录按层级缩进', () => {
  const toc = buildTocMarkdown(scanHeadings(SOURCE))
  assert.equal(toc, [
    '- [标题](#标题)',
    '  - [1.1 背景](#11-背景)',
    '  - [标题](#标题-1)',
    '    - [细节](#细节)'
  ].join('\n'))
})

test('插入目录在 front matter 之后,更新幂等且标记不渲染', () => {
  const once = insertOrUpdateToc(SOURCE)
  assert.ok(once.includes(TOC_START) && once.includes(TOC_END))
  assert.ok(once.indexOf(TOC_START) > once.indexOf('title: 示例'))
  assert.ok(once.includes('- [标题](#标题)'))

  const twice = insertOrUpdateToc(once)
  assert.equal(twice, once)
  assert.equal((twice.match(/oot-toc\)/g) || []).length, 1)
  assert.equal((twice.match(/oot-toc-end\)/g) || []).length, 1)

  const html = renderWithIds(stripFrontMatter(once))
  assert.ok(!html.includes('oot-toc'), '链接引用定义不应出现在 HTML 中')
  assert.ok(html.includes('id="标题"'))
  assert.ok(html.includes('href="#11-%E8%83%8C%E6%99%AF"') || html.includes('href="#11-背景"'))
})

test('assignHeadingIds 与目录 slug 完全一致', () => {
  const body = stripFrontMatter(SOURCE)
  const tokens = new MarkdownIt().parse(body, {})
  const headings = assignHeadingIds(tokens)
  const ids = tokens.filter((t) => t.type === 'heading_open').map((t) => t.attrGet('id'))
  assert.deepEqual(ids, headings.map((h) => h.slug))
  assert.deepEqual(ids, scanHeadings(SOURCE).map((h) => h.slug))

  const html = renderWithIds(body)
  assert.ok(html.includes('id="标题"'))
  assert.ok(html.includes('id="标题-1"'))
  assert.ok(!html.includes('id="title-示例"'))
})

test('孤立起始标记连同遗留目录一起替换', () => {
  const dirty = `# 标题\n\n${TOC_START}\n\n- [旧条目](#旧)\n\n## 小节\n`
  const fixed = insertOrUpdateToc(dirty)
  assert.equal((fixed.match(/oot-toc\)/g) || []).length, 1)
  assert.equal((fixed.match(/oot-toc-end\)/g) || []).length, 1)
  assert.ok(!fixed.includes('旧条目'))
  assert.ok(fixed.includes('- [标题](#标题)'))
  assert.ok(fixed.includes('## 小节'))
  assert.equal(insertOrUpdateToc(fixed), fixed)
})

test('孤立结束标记被删除', () => {
  const dirty = `# 标题\n\n${TOC_END}\n\n段落\n`
  const fixed = insertOrUpdateToc(dirty)
  assert.equal((fixed.match(/oot-toc-end\)/g) || []).length, 1)
  assert.equal((fixed.match(/oot-toc\)/g) || []).length, 1)
  assert.ok(fixed.includes('段落'))
})

test('没有标题时插入目录报错', () => {
  assert.throws(() => insertOrUpdateToc('普通段落'), /没有找到/)
})
