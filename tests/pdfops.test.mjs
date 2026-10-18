import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const { PDFDocument, StandardFonts } = require('pdf-lib')
const fontkit = require('@pdf-lib/fontkit')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')

// pdfOps 是带 import 的 ESM,用 Vite 的 SSR 加载器载入(和渲染层同一份源码)
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
const ops = await server.ssrLoadModule('/src/renderer/src/utils/pdfOps.js')

after(async () => {
  await server.close()
})

const SIMHEI = `${process.env.WINDIR || 'C:\\Windows'}\\Fonts\\simhei.ttf`

async function makeDoc(pageCount = 3, width = 595, height = 842) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pageCount; i += 1) doc.addPage([width, height])
  return { doc, font }
}

async function extractText(bytes) {
  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise
  const out = []
  try {
    for (let i = 1; i <= jsDoc.numPages; i += 1) {
      const page = await jsDoc.getPage(i)
      const content = await page.getTextContent()
      out.push(content.items.map((item) => item.str).join(''))
    }
  } finally {
    jsDoc.destroy()
  }
  return out
}

test('addPageNumbers 用 {n}/{total} 写页码', async () => {
  const { doc, font } = await makeDoc(3)
  ops.addPageNumbers(doc, { format: '{n}/{total}' }, font)
  const pages = await extractText(await doc.save())
  assert.equal(pages.length, 3)
  assert.ok(pages[0].includes('1/3'), `第 1 页应含 1/3,实际:${pages[0]}`)
  assert.ok(pages[2].includes('3/3'), `第 3 页应含 3/3,实际:${pages[2]}`)
})

test('addPageNumbers 支持起始页与指定页', async () => {
  const { doc, font } = await makeDoc(3)
  ops.addPageNumbers(doc, { pages: [1], start: 10, format: '{n}' }, font)
  const pages = await extractText(await doc.save())
  assert.equal(pages[0].trim(), '')
  assert.equal(pages[1].trim(), '10')
})

test('中文页码与水印(CJK 子集嵌入)', { skip: !existsSync(SIMHEI) ? '缺少 simhei.ttf' : false }, async () => {
  const { doc } = await makeDoc(1)
  doc.registerFontkit(fontkit.default || fontkit)
  const cjk = await doc.embedFont(readFileSync(SIMHEI), { subset: true })
  ops.addPageNumbers(doc, { format: '第{n}页' }, cjk)
  ops.addWatermark(doc, { text: '内部资料' }, cjk)
  const [text] = await extractText(await doc.save())
  assert.ok(text.includes('第1页'), `应含 第1页,实际:${text}`)
  assert.ok(text.includes('内部资料'), `应含 内部资料,实际:${text}`)
})

test('addWatermark 居中与平铺', async () => {
  const { doc, font } = await makeDoc(1)
  ops.addWatermark(doc, { text: 'TEST', tile: false }, font)
  let [text] = await extractText(await doc.save())
  assert.equal((text.match(/TEST/g) || []).length, 1)

  const tiled = await makeDoc(1)
  ops.addWatermark(tiled.doc, { text: 'TEST', tile: true }, tiled.font)
  ;[text] = await extractText(await tiled.doc.save())
  assert.ok((text.match(/TEST/g) || []).length > 5, `平铺应重复绘制,实际 ${(text.match(/TEST/g) || []).length} 次`)

  const empty = await makeDoc(1)
  assert.throws(() => ops.addWatermark(empty.doc, { text: '   ' }, empty.font), /水印文字不能为空/)
})

test('cropPages 按边距裁 CropBox', async () => {
  const { doc } = await makeDoc(1, 595, 842)
  ops.cropPages(doc, 10)
  const reloaded = await PDFDocument.load(await doc.save())
  const box = reloaded.getPage(0).getCropBox()
  assert.equal(box.width, 575)
  assert.equal(box.height, 822)
  assert.throws(() => ops.cropPages(reloaded, 300), /边距需在 0–200pt 之间/)
  assert.throws(() => ops.cropPages(reloaded, -1), /边距需在 0–200pt 之间/)

  const small = await makeDoc(1, 100, 100)
  assert.throws(() => ops.cropPages(small.doc, 60), /边距过大/)
})

test('clearMetadata 清空文档信息', async () => {
  const { doc } = await makeDoc(1)
  doc.setTitle('x')
  doc.setAuthor('y')
  ops.clearMetadata(doc)
  const reloaded = await PDFDocument.load(await doc.save())
  assert.ok(!reloaded.getTitle())
  assert.ok(!reloaded.getAuthor())
})

test('setOutlines 写入层级书签并可读回', async () => {
  const { doc } = await makeDoc(3)
  const items = [
    { level: 1, title: 'A', page: 1 },
    { level: 2, title: 'B', page: 2 },
    { level: 1, title: 'C', page: 3 }
  ]
  ops.setOutlines(doc, items)
  const bytes = await doc.save()

  const reloaded = await PDFDocument.load(bytes)
  assert.deepEqual(ops.readOutlines(reloaded), [[1, 'A', 1], [2, 'B', 2], [1, 'C', 3]])

  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise
  const outline = await jsDoc.getOutline()
  await jsDoc.destroy()
  assert.equal(outline.length, 2)
  assert.equal(outline[0].title, 'A')
  assert.equal(outline[0].items[0].title, 'B')
  assert.equal(outline[1].title, 'C')
})

test('setOutlines 覆盖旧书签并校验输入', async () => {
  const { doc } = await makeDoc(3)
  ops.setOutlines(doc, [{ level: 1, title: '旧', page: 1 }])
  ops.setOutlines(doc, [{ level: 1, title: '新', page: 2 }])
  const reloaded = await PDFDocument.load(await doc.save())
  assert.deepEqual(ops.readOutlines(reloaded), [[1, '新', 2]])

  assert.throws(() => ops.setOutlines(reloaded, [{ level: 1, title: 'X', page: 99 }]), /页码需在 1–3 之间/)
  assert.throws(() => ops.setOutlines(reloaded, [{ level: 7, title: 'X', page: 1 }]), /层级需为 1–6/)
  assert.throws(() => ops.setOutlines(reloaded, [{ level: 1, title: '  ', page: 1 }]), /标题不能为空/)
  assert.throws(() => ops.setOutlines(reloaded, []), /书签内容不能为空/)
})

test('setOutlines 按页码稳定排序', async () => {
  const { doc } = await makeDoc(3)
  ops.setOutlines(doc, [
    { level: 1, title: 'p3', page: 3 },
    { level: 1, title: 'p1a', page: 1 },
    { level: 1, title: 'p1b', page: 1 }
  ])
  const reloaded = await PDFDocument.load(await doc.save())
  assert.deepEqual(ops.readOutlines(reloaded), [[1, 'p1a', 1], [1, 'p1b', 1], [1, 'p3', 3]])
})
