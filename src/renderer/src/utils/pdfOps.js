import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
  degrees,
  rgb
} from 'pdf-lib'
import { alignBox, normalizePageRotation, placeRotatedBox, rotatedBounds, visualToPagePoint } from './pdfLayout.js'

const PAGE_NUMBER_COLORS = {
  gray: rgb(0.45, 0.45, 0.45),
  black: rgb(0, 0, 0),
  red: rgb(0.9, 0.1, 0.1),
  blue: rgb(0.1, 0.2, 0.8)
}

const WATERMARK_COLORS = {
  gray: rgb(0.5, 0.5, 0.5),
  red: rgb(0.9, 0.2, 0.2),
  blue: rgb(0.2, 0.4, 0.9)
}

// 页码位置白名单,和界面的下拉一致
const PAGE_NUMBER_POSITIONS = ['bottom-center', 'bottom-right', 'bottom-left', 'top-center']

export function clearMetadata(doc) {
  doc.setTitle('')
  doc.setAuthor('')
  doc.setSubject('')
  doc.setKeywords([])
  doc.setCreator('')
  doc.setProducer('')
}

export function readMetadata(doc) {
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || ''
  }
}

// 只改传入的字段;空字符串表示清空该字段。关键词支持中英文逗号/分号分隔
export function setMetadata(doc, fields = {}) {
  const clean = (value) => String(value ?? '').trim().slice(0, 512)
  if ('title' in fields) doc.setTitle(clean(fields.title))
  if ('author' in fields) doc.setAuthor(clean(fields.author))
  if ('subject' in fields) doc.setSubject(clean(fields.subject))
  if ('keywords' in fields) {
    const list = Array.isArray(fields.keywords)
      ? fields.keywords
      : String(fields.keywords ?? '').split(/[,，;；\s]+/)
    doc.setKeywords(list.map((k) => String(k).trim().slice(0, 128)).filter(Boolean))
  }
}

// 在 at 处插入另一个文档的页面;at=0 最前,at=pageCount 追加到末尾
export async function insertPdfPages(doc, srcDoc, at, indices) {
  const pageCount = doc.getPageCount()
  const pos = Math.trunc(Number(at))
  if (!Number.isInteger(pos) || pos < 0 || pos > pageCount) {
    throw new Error(`插入位置需在 0–${pageCount} 之间`)
  }
  const srcCount = srcDoc.getPageCount()
  const list = Array.isArray(indices) && indices.length ? indices : srcDoc.getPageIndices()
  if (!list.length) throw new Error('没有要插入的页面')
  if (!list.every((i) => Number.isInteger(i) && i >= 0 && i < srcCount)) {
    throw new Error(`插入页码需在 1–${srcCount} 之间`)
  }
  const copied = await doc.copyPages(srcDoc, list)
  copied.forEach((page, i) => doc.insertPage(pos + i, page))
  return copied.length
}

export function insertBlankPages(doc, at, count, size) {
  const pageCount = doc.getPageCount()
  const pos = Math.trunc(Number(at))
  const n = Math.trunc(Number(count))
  if (!Number.isInteger(pos) || pos < 0 || pos > pageCount) {
    throw new Error(`插入位置需在 0–${pageCount} 之间`)
  }
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('空白页数需在 1–1000 之间')
  const dims = size == null ? [595.28, 841.89] : size
  if (!Array.isArray(dims) || dims.length !== 2 || !(dims[0] > 0) || !(dims[1] > 0)) {
    throw new Error('空白页尺寸无效')
  }
  for (let i = 0; i < n; i += 1) doc.insertPage(pos + i, [dims[0], dims[1]])
  return n
}

const STAMP_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'
]

// 把已嵌入的图片盖到指定页;CropBox 原点不一定在 (0,0),绘制坐标要加上偏移
export function stampImage(doc, image, opts = {}) {
  if (!image || !(image.width > 0) || !(image.height > 0)) throw new Error('盖章图片无效')
  const pages = Array.isArray(opts.pages) && opts.pages.length ? opts.pages : doc.getPageIndices()
  if (!pages.every((i) => Number.isInteger(i) && i >= 0 && i < doc.getPageCount())) {
    throw new Error('盖章页码无效')
  }
  const pos = STAMP_POSITIONS.includes(opts.pos) ? opts.pos : 'bottom-right'
  const widthPct = opts.widthPercent == null ? 30 : Number(opts.widthPercent)
  if (!Number.isFinite(widthPct) || widthPct < 1 || widthPct > 100) {
    throw new Error('盖章宽度需在 1%–100% 之间')
  }
  const opacityRaw = Number(opts.opacity)
  const opacity = Number.isFinite(opacityRaw) ? Math.min(1, Math.max(0.02, opacityRaw)) : 1
  const angle = Number(opts.angle) || 0
  if (!Number.isFinite(angle) || angle < -180 || angle > 180) {
    throw new Error('盖章角度需在 -180°–180° 之间')
  }
  const marginRaw = Number(opts.margin)
  const margin = Number.isFinite(marginRaw) ? marginRaw : 24
  if (margin < 0 || margin > 200) throw new Error('盖章边距需在 0–200pt 之间')

  for (const index of pages) {
    const page = doc.getPage(index)
    const box = page.getCropBox()
    const pageW = box.width
    const pageH = box.height
    const rotation = normalizePageRotation(page.getRotation().angle)
    const visualW = rotation === 90 || rotation === 270 ? pageH : pageW
    const visualH = rotation === 90 || rotation === 270 ? pageW : pageH
    const availW = visualW - 2 * margin
    const availH = visualH - 2 * margin
    if (availW < 4 || availH < 4) throw new Error('边距过大,盖章区域不足')

    let width = (visualW * widthPct) / 100
    let height = (width * image.height) / image.width
    let bounds = rotatedBounds(angle, width, height)
    if (bounds.bboxW > availW || bounds.bboxH > availH) {
      const scale = Math.min(availW / bounds.bboxW, availH / bounds.bboxH)
      width *= scale
      height *= scale
      bounds = rotatedBounds(angle, width, height)
    }
    const { x: vx, y: vy } = alignBox(bounds.bboxW, bounds.bboxH, visualW, visualH, pos, margin)
    const center = visualToPagePoint(rotation, vx + bounds.bboxW / 2, vy + bounds.bboxH / 2, pageW, pageH)
    const drawAngle = angle + rotation
    const pb = rotatedBounds(drawAngle, width, height)
    const placed = placeRotatedBox(drawAngle, width, height, center.x - pb.bboxW / 2, center.y - pb.bboxH / 2)
    page.drawImage(image, {
      x: box.x + placed.x,
      y: box.y + placed.y,
      width,
      height,
      opacity,
      rotate: degrees(drawAngle)
    })
  }
  return pages.length
}

export function cropPages(doc, margin) {
  const m = Number(margin)
  if (!Number.isFinite(m) || m < 0 || m > 200) throw new Error('边距需在 0–200pt 之间')
  for (const page of doc.getPages()) {
    const box = page.getCropBox()
    const width = box.width - 2 * m
    const height = box.height - 2 * m
    if (width < 1 || height < 1) throw new Error('边距过大,页面无内容可裁')
    page.setCropBox(box.x + m, box.y + m, width, height)
  }
}

export function addPageNumbers(doc, opts = {}, font) {
  if (!font) throw new Error('缺少字体')
  const pages = Array.isArray(opts.pages) && opts.pages.length ? opts.pages : doc.getPageIndices()
  const start = Number(opts.start) || 1
  const pos = PAGE_NUMBER_POSITIONS.includes(opts.pos) ? opts.pos : 'bottom-center'
  const format = typeof opts.format === 'string' && opts.format ? opts.format : '第{n}页'
  const color = PAGE_NUMBER_COLORS[opts.color] || PAGE_NUMBER_COLORS.gray
  const size = 9
  const margin = 24
  const top = pos.startsWith('top')
  const align = pos.endsWith('left') ? 'left' : pos.endsWith('right') ? 'right' : 'center'
  const total = doc.getPageCount()

  pages.forEach((pageIndex, rank) => {
    const page = doc.getPage(pageIndex)
    const text = format.replace(/\{n\}/g, String(start + rank)).replace(/\{total\}/g, String(total))
    const width = font.widthOfTextAtSize(text, size)
    const pageWidth = page.getWidth()
    const pageHeight = page.getHeight()
    const x = align === 'left'
      ? margin
      : align === 'right' ? pageWidth - margin - width : pageWidth / 2 - width / 2
    const y = top ? pageHeight - margin - size : margin
    page.drawText(text, { x, y, size, font, color })
  })
}

export function addWatermark(doc, opts = {}, font) {
  if (!font) throw new Error('缺少字体')
  const text = String(opts.text ?? '').trim()
  if (!text) throw new Error('水印文字不能为空')
  const color = WATERMARK_COLORS[opts.color] || WATERMARK_COLORS.gray
  const opacity = Math.min(1, Math.max(0.01, Number(opts.opacity) || 0.15))
  const rotate = degrees(Number(opts.angle) || 0)
  const tile = Boolean(opts.tile)

  for (const page of doc.getPages()) {
    const pageWidth = page.getWidth()
    const pageHeight = page.getHeight()
    if (tile) {
      const size = Math.min(20, pageHeight / 28)
      const stepX = Math.max(font.widthOfTextAtSize(text, size) + 40, 150)
      const stepY = Math.max(size * 2.4, 80)
      for (let y = -stepY; y <= pageHeight + stepY; y += stepY) {
        for (let x = -stepX; x <= pageWidth + stepX; x += stepX) {
          page.drawText(text, { x, y, size, font, color, opacity, rotate })
        }
      }
    } else {
      const size = Math.min(72, pageHeight / 12)
      const width = font.widthOfTextAtSize(text, size)
      page.drawText(text, {
        x: pageWidth / 2 - width / 2,
        y: pageHeight / 2 - size / 2,
        size,
        font,
        color,
        opacity,
        rotate
      })
    }
  }
}

// 目标可以是 dict,也可以是引用;统一解析成 dict
function asDict(doc, value) {
  if (value instanceof PDFDict) return value
  if (value instanceof PDFRef) {
    const target = doc.context.lookup(value)
    if (target instanceof PDFDict) return target
  }
  return null
}

function outlineTitle(doc, dict) {
  const raw = dict.get(PDFName.of('Title'))
  const title = raw instanceof PDFRef ? doc.context.lookup(raw) : raw
  if (title instanceof PDFHexString || title instanceof PDFString) return title.decodeText()
  if (title instanceof PDFName) return title.toString().replace(/^\//, '')
  return ''
}

// 命名目标 / 间接引用 / 动作字典都收敛到「页码」;解析不到按第 1 页(源项目同行为)
function destToPage(doc, dest, depth = 0) {
  if (dest == null || depth > 4) return 1
  const target = dest instanceof PDFRef ? doc.context.lookup(dest) : dest
  if (target == null) return 1
  if (target instanceof PDFDict) return destToPage(doc, target.get(PDFName.of('D')), depth + 1)
  if (target instanceof PDFArray) {
    const first = target.get(0)
    if (first instanceof PDFRef) {
      const pages = doc.getPages()
      const key = first.toString()
      for (let i = 0; i < pages.length; i += 1) {
        if (pages[i].ref.toString() === key) return i + 1
      }
    }
    if (first instanceof PDFNumber) return Math.max(1, Math.trunc(first.asNumber()))
    return 1
  }
  if (target instanceof PDFString || target instanceof PDFName) {
    const name = target instanceof PDFString ? target.decodeText() : target.toString().slice(1)
    const dests = doc.catalog.lookup(PDFName.of('Dests'))
    if (dests instanceof PDFDict) return destToPage(doc, dests.get(PDFName.of(name)), depth + 1)
  }
  return 1
}

function outlinePage(doc, dict) {
  const action = asDict(doc, dict.get(PDFName.of('A')))
  const dest = dict.get(PDFName.of('Dest')) ?? (action ? action.get(PDFName.of('D')) : undefined)
  return destToPage(doc, dest)
}

// 返回扁平数组 [[level, title, page], ...],层级从 1 开始
export function readOutlines(doc) {
  const out = []
  const root = asDict(doc, doc.catalog.get(PDFName.of('Outlines')))
  if (!root) return out
  let budget = 5000
  const walk = (parent, level) => {
    if (level > 10) return
    let node = asDict(doc, parent.get(PDFName.of('First')))
    // budget 同时也是死循环兜底(损坏的 Next/First 环)
    while (node && budget > 0) {
      budget -= 1
      out.push([level, outlineTitle(doc, node), outlinePage(doc, node)])
      walk(node, level + 1)
      node = asDict(doc, node.get(PDFName.of('Next')))
    }
  }
  walk(root, 1)
  return out
}

function collectOldRefs(doc, ref, out, depth) {
  const seen = new Set()
  let cur = ref
  while (cur instanceof PDFRef && !seen.has(cur.toString()) && out.length <= 5000) {
    seen.add(cur.toString())
    const dict = doc.context.lookup(cur)
    if (!(dict instanceof PDFDict)) return
    out.push(cur)
    const first = dict.get(PDFName.of('First'))
    if (first instanceof PDFRef && depth < 20) collectOldRefs(doc, first, out, depth + 1)
    cur = dict.get(PDFName.of('Next'))
  }
}

export function setOutlines(doc, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('书签内容不能为空')
  const pageCount = doc.getPageCount()
  const pages = doc.getPages()
  const ctx = doc.context

  const normalized = items.map((item, index) => {
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title) throw new Error('书签标题不能为空')
    const page = Math.trunc(Number(item.page))
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      throw new Error(`书签「${title}」页码需在 1–${pageCount} 之间`)
    }
    const level = Math.trunc(Number(item.level))
    if (!Number.isInteger(level) || level < 1 || level > 6) {
      throw new Error(`书签「${title}」层级需为 1–6 的整数`)
    }
    return { title, page, level, index }
  })
  // 稳定排序:同页保持输入顺序
  normalized.sort((a, b) => (a.page - b.page) || (a.index - b.index))

  const rootRef = ctx.nextRef()
  const rootDict = ctx.obj({})
  rootDict.set(PDFName.of('Type'), PDFName.of('Outlines'))
  const root = { level: 0, ref: rootRef, dict: rootDict, count: 0 }
  const stack = [root]
  const nodes = []

  for (const item of normalized) {
    const page = pages[item.page - 1]
    const dest = PDFArray.withContext(ctx)
    dest.push(page.ref)
    dest.push(PDFName.of('XYZ'))
    dest.push(PDFNumber.of(0))
    dest.push(PDFNumber.of(page.getHeight()))
    dest.push(PDFNull)

    // 必须先 assign:下面要通过 ref 反查上一个兄弟节点来串 Next/Prev
    const node = { level: item.level, ref: ctx.nextRef(), dict: ctx.obj({}), count: 0 }
    ctx.assign(node.ref, node.dict)
    node.dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title))
    node.dict.set(PDFName.of('Dest'), dest)

    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop()
    const parent = stack[stack.length - 1]
    node.dict.set(PDFName.of('Parent'), parent.ref)
    const firstRef = parent.dict.get(PDFName.of('First'))
    if (firstRef === undefined) {
      parent.dict.set(PDFName.of('First'), node.ref)
    } else {
      const lastRef = parent.dict.get(PDFName.of('Last'))
      const lastDict = lastRef === undefined ? null : ctx.lookup(lastRef)
      if (lastDict instanceof PDFDict) lastDict.set(PDFName.of('Next'), node.ref)
      node.dict.set(PDFName.of('Prev'), lastRef)
    }
    parent.dict.set(PDFName.of('Last'), node.ref)
    for (const ancestor of stack) ancestor.count += 1
    stack.push(node)
    nodes.push(node)
  }

  rootDict.set(PDFName.of('Count'), PDFNumber.of(nodes.length))
  for (const node of nodes) node.dict.set(PDFName.of('Count'), PDFNumber.of(node.count))

  const oldOutlines = doc.catalog.get(PDFName.of('Outlines'))
  if (oldOutlines !== undefined) {
    const oldRefs = []
    if (oldOutlines instanceof PDFRef) collectOldRefs(doc, oldOutlines, oldRefs, 0)
    doc.catalog.delete(PDFName.of('Outlines'))
    for (const ref of oldRefs) ctx.delete(ref)
  }

  ctx.assign(rootRef, rootDict)
  doc.catalog.set(PDFName.of('Outlines'), rootRef)
}

