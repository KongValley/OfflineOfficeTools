import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFDict, PDFName, PDFNumber, StandardFonts, degrees } = require('pdf-lib')
const Jimp = require('jimp')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent'
})
const compose = await server.ssrLoadModule('/src/renderer/src/utils/pdfCompose.js')
const ops = await server.ssrLoadModule('/src/renderer/src/utils/pdfOps.js')

after(async () => {
  await server.close()
})

async function makeTextDoc(texts, sizes = [], rotations = []) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  texts.forEach((text, i) => {
    const page = doc.addPage(sizes[i] || [595.28, 841.89])
    if (text) page.drawText(text, { x: 50, y: 50, size: 12, font })
    if (rotations[i]) page.setRotation(degrees(rotations[i]))
  })
  return doc
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

// 用 pdf.js 算子列表累计 CTM,取出图片在未旋转页面坐标里的外接框
async function imageBoxes(bytes, pageNo) {
  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise
  try {
    const page = await jsDoc.getPage(pageNo)
    const list = await page.getOperatorList()
    const boxes = []
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack = []
    const mul = (m, n) => [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ]
    for (let i = 0; i < list.fnArray.length; i += 1) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i]
      if (fn === pdfjsLib.OPS.save) {
        stack.push(ctm.slice())
      } else if (fn === pdfjsLib.OPS.restore) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
      } else if (fn === pdfjsLib.OPS.transform) {
        ctm = mul(ctm, args)
      } else if (fn === pdfjsLib.OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice())
        if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0])
      } else if (fn === pdfjsLib.OPS.paintFormXObjectEnd) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
      } else if (fn === pdfjsLib.OPS.paintImageXObject) {
        const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([px, py]) => [
          ctm[0] * px + ctm[2] * py + ctm[4],
          ctm[1] * px + ctm[3] * py + ctm[5]
        ])
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        boxes.push({
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs),
          h: Math.max(...ys) - Math.min(...ys)
        })
      }
    }
    return boxes
  } finally {
    jsDoc.destroy()
  }
}

test('imposeNup 2 合 1:A4 横向、页数与顺序', async () => {
  const src = await makeTextDoc(['P1', 'P2', 'P3', 'P4', 'P5'])
  const out = await compose.imposeNup(src, { n: 2 })
  const bytes = await out.save()
  const reloaded = await PDFDocument.load(bytes)
  assert.equal(reloaded.getPageCount(), 3)
  const { width, height } = reloaded.getPage(0).getSize()
  assert.ok(Math.abs(width - 841.89) < 0.01 && Math.abs(height - 595.28) < 0.01)
  const texts = await extractText(bytes)
  assert.ok(texts[0].includes('P1') && texts[0].includes('P2'), texts[0])
  assert.ok(texts[2].includes('P5'), texts[2])
})

test('imposeNup 4/9 合 1 的纸张与页数', async () => {
  const src = await makeTextDoc(Array.from({ length: 10 }, (_, i) => `Q${i + 1}`))
  const four = await compose.imposeNup(src, { n: 4 })
  assert.equal(four.getPageCount(), 3)
  const fourSize = four.getPage(0).getSize()
  assert.ok(Math.abs(fourSize.width - 595.28) < 0.01 && Math.abs(fourSize.height - 841.89) < 0.01)

  const nine = await compose.imposeNup(src, { n: 9, margin: 10, gap: 4 })
  assert.equal(nine.getPageCount(), 2)
})

test('imposeNup 跳过无 Contents 的空白页', async () => {
  const src = await makeTextDoc(['A', '', 'B'])
  const out = await compose.imposeNup(src, { n: 2 })
  assert.equal(out.getPageCount(), 2)
  const texts = await extractText(await out.save())
  assert.ok(texts[0].includes('A'))
  assert.ok(texts[1].includes('B'))
})

test('unifyPageSize 统一纸张并按可见方向自动横竖', async () => {
  const src = await makeTextDoc(['small', 'wide', 'rot'], [
    [300, 500], [800, 300], [600, 900]
  ], [0, 0, 90])
  const out = await compose.unifyPageSize(src, { pageSize: 'a4', margin: 12 })
  const reloaded = await PDFDocument.load(await out.save())
  assert.equal(reloaded.getPageCount(), 3)
  const p0 = reloaded.getPage(0).getSize()
  const p1 = reloaded.getPage(1).getSize()
  const p2 = reloaded.getPage(2).getSize()
  assert.ok(p0.height > p0.width, '竖向源页 → A4 竖向')
  assert.ok(p1.width > p1.height, '横向源页 → A4 横向')
  assert.ok(p2.width > p2.height, '/Rotate 90 → 可见方向为横向')
})

test('imposeNup / unifyPageSize 支持页码范围', async () => {
  const src = await makeTextDoc(['A', 'B', 'C', 'D'])
  const out = await compose.imposeNup(src, { n: 2, pages: [1, 2] })
  const bytes = await out.save()
  const reloaded = await PDFDocument.load(bytes)
  assert.equal(reloaded.getPageCount(), 1)
  const texts = await extractText(bytes)
  assert.ok(texts[0].includes('B') && texts[0].includes('C'), texts[0])
  assert.ok(!texts[0].includes('A') && !texts[0].includes('D'))

  const single = await compose.imposeNup(src, { n: 2, pages: [3] })
  assert.equal(single.getPageCount(), 1)

  const fit = await compose.unifyPageSize(src, { pageSize: 'a4', pages: [1] })
  const fitReloaded = await PDFDocument.load(await fit.save())
  assert.equal(fitReloaded.getPageCount(), 1)
  assert.ok(Math.abs(fitReloaded.getPage(0).getSize().width - 595.28) < 0.01)

  await assert.rejects(compose.imposeNup(src, { n: 2, pages: [99] }), /页码范围无效/)
  await assert.rejects(compose.unifyPageSize(src, { pageSize: 'a4', pages: [] }), /页码范围为空/)
})

test('insertPdfPages 按位置插入并保持顺序', async () => {
  const target = await makeTextDoc(['A', 'B', 'C'])
  const source = await makeTextDoc(['X', 'Y'])
  const count = await ops.insertPdfPages(target, source, 1, [0, 1])
  assert.equal(count, 2)
  const texts = await extractText(await target.save())
  assert.equal(texts.length, 5)
  assert.deepEqual(texts.map((t) => t.trim()), ['A', 'X', 'Y', 'B', 'C'])
})

test('insertBlankPages 支持最前/末尾与自定义尺寸', async () => {
  const doc = await makeTextDoc(['A'])
  ops.insertBlankPages(doc, 0, 2, [300, 400])
  ops.insertBlankPages(doc, doc.getPageCount(), 1, [200, 500])
  const reloaded = await PDFDocument.load(await doc.save())
  assert.equal(reloaded.getPageCount(), 4)
  assert.deepEqual(reloaded.getPage(0).getSize(), { width: 300, height: 400 })
  assert.deepEqual(reloaded.getPage(3).getSize(), { width: 200, height: 500 })
  assert.throws(() => ops.insertBlankPages(reloaded, 9, 1), /插入位置/)
  assert.throws(() => ops.insertBlankPages(reloaded, 0, 0), /空白页数/)
})

test('setMetadata 写入并可读回,空值清空', async () => {
  const doc = await makeTextDoc(['A'])
  ops.setMetadata(doc, {
    title: '  标题  ',
    author: '作者',
    subject: '主题',
    keywords: '合同，2026;重要'
  })
  const reloaded = await PDFDocument.load(await doc.save())
  const meta = ops.readMetadata(reloaded)
  assert.equal(meta.title, '标题')
  assert.equal(meta.author, '作者')
  assert.equal(meta.subject, '主题')
  assert.equal(meta.keywords, '合同 2026 重要')

  ops.setMetadata(reloaded, { title: '', author: '' })
  const cleared = await PDFDocument.load(await reloaded.save())
  assert.equal(ops.readMetadata(cleared).title, '')
  assert.equal(ops.readMetadata(cleared).author, '')

  // pdf-lib 用空格 join;读取后再原样保存不能把整串并成一个关键词
  ops.setMetadata(cleared, { keywords: '合同 2026 重要' })
  const again = await PDFDocument.load(await cleared.save())
  assert.equal(ops.readMetadata(again).keywords, '合同 2026 重要')

  ops.setMetadata(again, { keywords: 'a,b' })
  const legacy = await PDFDocument.load(await again.save())
  assert.equal(ops.readMetadata(legacy).keywords, 'a b')
})

test('stampImage 盖到指定页并保留原页数', async () => {
  const doc = await makeTextDoc(['A', 'B'], [[300, 400], [300, 400]])
  doc.getPage(0).setCropBox(10, 20, 280, 360)
  const png = await new Jimp(20, 10, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG)
  const image = await doc.embedPng(png)
  const count = ops.stampImage(doc, image, {
    pages: [0, 1],
    pos: 'bottom-right',
    widthPercent: 30,
    opacity: 0.8,
    angle: 30,
    margin: 10
  })
  assert.equal(count, 2)
  const bytes = await doc.save()
  const reloaded = await PDFDocument.load(bytes)
  assert.equal(reloaded.getPageCount(), 2)

  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise
  try {
    for (let i = 1; i <= 2; i += 1) {
      const page = await jsDoc.getPage(i)
      const list = await page.getOperatorList()
      assert.ok(list.fnArray.includes(pdfjsLib.OPS.paintImageXObject), `第 ${i} 页应有图片`)
    }
  } finally {
    jsDoc.destroy()
  }

  const fresh = await makeTextDoc(['A'])
  const img = await fresh.embedPng(png)
  assert.throws(() => ops.stampImage(fresh, img, { widthPercent: 0 }), /宽度/)
  assert.throws(() => ops.stampImage(fresh, img, { angle: 400 }), /角度/)
  assert.throws(() => ops.stampImage(fresh, img, { margin: 400 }), /边距/)
})

test('stampImage 补偿页面 /Rotate 并按可见页面定位', async () => {
  const doc = await makeTextDoc(['R'], [[300, 400]])
  doc.getPage(0).setRotation(degrees(90))
  const png = await new Jimp(20, 10, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG)
  const image = await doc.embedPng(png)
  ops.stampImage(doc, image, {
    pages: [0],
    pos: 'bottom-right',
    widthPercent: 30,
    angle: 0,
    opacity: 0.5,
    margin: 24
  })
  const bytes = await doc.save()

  const reloaded = await PDFDocument.load(bytes)
  const states = reloaded.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'), PDFDict)
  let ca = null
  for (const [, ref] of states.entries()) {
    const value = reloaded.context.lookup(ref, PDFDict).lookup(PDFName.of('ca'), PDFNumber)
    if (value) ca = value.asNumber()
  }
  assert.ok(ca != null && Math.abs(ca - 0.5) < 1e-6, `ca=${ca}`)

  const boxes = await imageBoxes(bytes, 1)
  assert.equal(boxes.length, 1)
  const box = boxes[0]
  // 可见页 400×300;宽 30% = 120,图 2:1 → 高 60;右下 24pt 边距 → 可见中心 (316,54)
  // 反算页面中心 (300-54, 316) = (246,316),页面外接框宽高互换为 60×120
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  assert.ok(Math.abs(cx - 246) < 1, `cx=${cx}`)
  assert.ok(Math.abs(cy - 316) < 1, `cy=${cy}`)
  assert.ok(Math.abs(box.w - 60) < 1 && Math.abs(box.h - 120) < 1, `${box.w}×${box.h}`)
  const visualU = cy
  const visualV = 300 - cx
  assert.ok(visualU > (400 * 2) / 3 && visualV < 300 / 3, `可见中心 ${visualU},${visualV}`)
})
