// PDF 拼版与页面尺寸统一:用 embedPage 保留矢量内容。
// 已知边界:embedPage 只复制内容流与 Resources,书签/链接/批注/表单不会带过去。
import { PDFDocument, degrees, MissingPageContentsEmbeddingError } from 'pdf-lib'
import { fitRotatedInCell, normalizePageRotation, nupCells } from './pdfLayout.js'

const PAPER = {
  a4: [595.28, 841.89],
  letter: [612, 792]
}

// 纵向纸张下的网格(行 × 列);横向时行列互换
const NUP_GRIDS = {
  2: [2, 1],
  4: [2, 2],
  6: [3, 2],
  9: [3, 3]
}

const NUP_COUNTS = [2, 4, 6, 9]

function paperDims(id) {
  return PAPER[id] || PAPER.a4
}

function cropBoxBBox(page) {
  const box = page.getCropBox()
  return { left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height }
}

function isBlankPageError(error) {
  return error instanceof MissingPageContentsEmbeddingError
}

// 真正的缺 Contents 错误发生在 save/flush 阶段,所以先看页面字典再决定是否 embed
function hasPageContents(page) {
  try {
    const entries = page.node.normalizedEntries()
    return Boolean(entries && entries.Contents)
  } catch {
    return true
  }
}

async function embedOrNull(out, srcPage) {
  if (!hasPageContents(srcPage)) return null
  try {
    return await out.embedPage(srcPage, cropBoxBBox(srcPage))
  } catch (e) {
    if (isBlankPageError(e)) return null
    throw e
  }
}

function drawEmbedded(targetPage, embedded, sourcePage, cell) {
  const rotation = normalizePageRotation(sourcePage.getRotation().angle)
  const placed = fitRotatedInCell(
    -rotation,
    embedded.width,
    embedded.height,
    cell.x,
    cell.y,
    cell.w,
    cell.h
  )
  targetPage.drawPage(embedded, {
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    rotate: degrees(placed.rotate)
  })
}

function readMargin(value, fallback, max) {
  const n = value == null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`留白需在 0–${max}pt 之间`)
  return n
}

function selectedPages(doc, pages) {
  if (pages == null) return doc.getPageIndices()
  if (!Array.isArray(pages) || !pages.length) throw new Error('页码范围为空')
  if (!pages.every((i) => Number.isInteger(i) && i >= 0 && i < doc.getPageCount())) {
    throw new Error('页码范围无效')
  }
  return pages
}

// 2/4/6/9 页合一张;opts = { n, pageSize:'a4'|'letter', orientation:'auto'|'portrait'|'landscape',
//   margin, gap, order:'row'|'column', pages:[0-based 索引] }
export async function imposeNup(srcDoc, opts = {}) {
  const n = NUP_COUNTS.includes(Number(opts.n)) ? Number(opts.n) : 2
  const [paperW, paperH] = paperDims(opts.pageSize)
  const orientation = opts.orientation === 'landscape' || opts.orientation === 'portrait'
    ? opts.orientation
    : 'auto'
  const landscape = orientation === 'landscape' || (orientation === 'auto' && n === 2)
  const sheetW = landscape ? paperH : paperW
  const sheetH = landscape ? paperW : paperH
  let [rows, cols] = NUP_GRIDS[n]
  if (landscape) [rows, cols] = [cols, rows]
  const margin = readMargin(opts.margin, 18, 72)
  const gap = readMargin(opts.gap, 6, 36)
  const cells = nupCells(sheetW, sheetH, cols, rows, margin, gap)
  const order = opts.order === 'column' ? 'column' : 'row'

  const out = await PDFDocument.create()
  const pages = selectedPages(srcDoc, opts.pages).map((i) => srcDoc.getPage(i))
  const title = srcDoc.getTitle()
  if (title) out.setTitle(title)

  for (let start = 0; start < pages.length; start += n) {
    const sheet = out.addPage([sheetW, sheetH])
    for (let k = 0; k < n && start + k < pages.length; k += 1) {
      const cellIndex = order === 'column'
        ? (k % rows) * cols + Math.floor(k / rows)
        : k
      const cell = cells[cellIndex]
      if (!cell) continue
      const srcPage = pages[start + k]
      const embedded = await embedOrNull(out, srcPage)
      if (!embedded) continue
      drawEmbedded(sheet, embedded, srcPage, cell)
    }
  }
  return out
}

// 每页统一到 A4/Letter;auto 方向按每页可见尺寸决定
export async function unifyPageSize(srcDoc, opts = {}) {
  const [paperW, paperH] = paperDims(opts.pageSize)
  const orientation = opts.orientation === 'landscape' || opts.orientation === 'portrait'
    ? opts.orientation
    : 'auto'
  const margin = readMargin(opts.margin, 12, 72)

  const out = await PDFDocument.create()
  const title = srcDoc.getTitle()
  if (title) out.setTitle(title)

  for (const srcPage of selectedPages(srcDoc, opts.pages).map((i) => srcDoc.getPage(i))) {
    const box = srcPage.getCropBox()
    const rotation = normalizePageRotation(srcPage.getRotation().angle)
    const visualW = rotation === 90 || rotation === 270 ? box.height : box.width
    const visualH = rotation === 90 || rotation === 270 ? box.width : box.height
    const landscape = orientation === 'landscape' || (orientation === 'auto' && visualW > visualH)
    const sheetW = landscape ? paperH : paperW
    const sheetH = landscape ? paperW : paperH
    const sheet = out.addPage([sheetW, sheetH])
    const embedded = await embedOrNull(out, srcPage)
    if (!embedded) continue
    const cell = {
      x: margin,
      y: margin,
      w: sheetW - 2 * margin,
      h: sheetH - 2 * margin
    }
    if (cell.w < 1 || cell.h < 1) throw new Error('留白过大,页面可用区域不足')
    drawEmbedded(sheet, embedded, srcPage, cell)
  }
  return out
}
