// 图片转 PDF 的页面几何:页面尺寸、等比居中矩形、按 DPI 的像素预算
// 纯 ESM 无 import,node --test 可经 data URL 直接载入(pageRange.js 同风格)

export const MAX_PAGE_PIXELS = 30000000 // 与主进程 MAX_IMAGE_PIXELS 一致

const A4 = [595.28, 841.89]
const LETTER = [612, 792]

// mode: 'a4' | 'a4p' | 'letter' | 'image';'image' 用像素当页面,custom margin 参与计算
export function pageSize(mode, imgW, imgH, margin = 0) {
  if (mode !== 'a4' && mode !== 'a4p' && mode !== 'letter' && mode !== 'image') {
    throw new Error('未知页面尺寸')
  }
  if (!(imgW > 0) || !(imgH > 0)) throw new Error('图片尺寸无效')
  if (mode === 'image') return [imgW + 2 * margin, imgH + 2 * margin]
  if (mode === 'a4p') return [...A4]
  const base = mode === 'a4' ? A4 : LETTER
  return imgW > imgH ? [base[1], base[0]] : [...base]
}

// 图片在页面可用区域内等比缩放并居中,返回 pt 矩形(不裁切、不拉伸)
export function fitRect(imgW, imgH, pageW, pageH, margin = 0) {
  if (!Number.isFinite(margin) || margin < 0) throw new Error('留白需在 0–72pt 之间')
  const availW = pageW - 2 * margin
  const availH = pageH - 2 * margin
  if (availW < 1 || availH < 1) throw new Error('留白过大,页面可用区域不足')
  const scale = Math.min(availW / imgW, availH / imgH)
  const width = imgW * scale
  const height = imgH * scale
  return { x: (pageW - width) / 2, y: (pageH - height) / 2, width, height }
}

// 固定页面下图片长边应有的像素数(按 DPI),再按 30MP 总像素预算收紧
export function resampleLongEdge(pageW, pageH, margin, dpi, imgW, imgH) {
  const d = Number(dpi)
  const target = Number.isFinite(d) ? Math.min(600, Math.max(72, d)) : 150
  let edge = Math.round((Math.max(pageW - 2 * margin, pageH - 2 * margin) / 72) * target)
  if (imgW > 0 && imgH > 0) {
    // 长边=edge、短边=edge*min(r,1/r) 时总像素 = edge^2 * min(r,1/r)
    const r = imgW / imgH
    edge = Math.min(edge, Math.floor(Math.sqrt(MAX_PAGE_PIXELS * Math.max(r, 1 / r))))
    // 主进程按 round(短边 = 长边 * 比例) 等比缩放,取整会向上多出半个像素,可能正好顶破预算
    const long = Math.max(imgW, imgH)
    while (edge > 1 && edge * Math.round((edge * Math.min(imgW, imgH)) / long) > MAX_PAGE_PIXELS) edge -= 1
  }
  return Math.max(1, edge)
}

// ---------- 拼版 / 页面尺寸统一 / 图片盖章的几何 ----------
// pdf-lib 的 PDFPageEmbedder 只看 MediaBox,不处理 CropBox 与 /Rotate;
// 这里把旋转后的外接框算清楚,调用方负责传 CropBox 和 /Rotate。

// 页面 /Rotate 归一到 0/90/180/270;非 90 倍数的异常值按 0 处理
export function normalizePageRotation(angle) {
  const a = Number(angle)
  if (!Number.isFinite(a)) return 0
  const r = ((a % 360) + 360) % 360
  return r === 90 || r === 180 || r === 270 ? r : 0
}

// 可视化坐标(页面顺时针旋转 rotation 后) → 未旋转页面坐标;rotation 归一到 0/90/180/270。
// 例 rotation=90:u=y, v=pageW-x,用于把按可见方向摆好的中心换算回页面坐标。
export function visualToPagePoint(rotation, u, v, pageW, pageH) {
  const r = normalizePageRotation(rotation)
  if (r === 90) return { x: pageW - v, y: u }
  if (r === 180) return { x: pageW - u, y: pageH - v }
  if (r === 270) return { x: v, y: pageH - u }
  return { x: u, y: v }
}

// 宽 w × 高 h 的矩形绕左下角逆时针转 angle 后的外接框
// minX/minY 是外接框相对旋转前原点的偏移,用于把外接框摆到指定位置。
// angle 可以是任意角度(图片盖章),页面 /Rotate 的 90 倍数校验由调用方负责。
export function rotatedBounds(angle, w, h) {
  if (!(w > 0) || !(h > 0)) throw new Error('对象尺寸无效')
  const raw = Number(angle)
  if (!Number.isFinite(raw)) throw new Error('旋转角度无效')
  const rad = ((((raw % 360) + 360) % 360) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const xs = [0, w * cos, -h * sin, w * cos - h * sin]
  const ys = [0, w * sin, h * cos, w * sin + h * cos]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return { bboxW: maxX - minX, bboxH: maxY - minY, minX, minY }
}

// 让旋转后的外接框左下角落在 (boxX, boxY),返回 drawPage/drawImage 参数
export function placeRotatedBox(angle, w, h, boxX, boxY) {
  if (!Number.isFinite(boxX) || !Number.isFinite(boxY)) throw new Error('目标位置无效')
  const raw = Number(angle)
  if (!Number.isFinite(raw)) throw new Error('旋转角度无效')
  const b = rotatedBounds(raw, w, h)
  return {
    x: boxX - b.minX,
    y: boxY - b.minY,
    width: w,
    height: h,
    rotate: ((raw % 360) + 360) % 360,
    bboxW: b.bboxW,
    bboxH: b.bboxH
  }
}

// 等比缩放后居中放进格子;用于拼版和统一页面尺寸。
// angle 传 -page.getRotation().angle,抵消 /Rotate。
export function fitRotatedInCell(angle, w, h, cellX, cellY, cellW, cellH) {
  if (!(cellW > 0) || !(cellH > 0)) throw new Error('格子尺寸无效')
  const b = rotatedBounds(angle, w, h)
  const scale = Math.min(cellW / b.bboxW, cellH / b.bboxH)
  const bw = b.bboxW * scale
  const bh = b.bboxH * scale
  return placeRotatedBox(
    angle,
    w * scale,
    h * scale,
    cellX + (cellW - bw) / 2,
    cellY + (cellH - bh) / 2
  )
}

// 9 宫格:把 bboxW × bboxH 的外接框摆进页面内缩 margin 的区域
const BOX_POSITIONS = {
  'top-left': ['left', 'top'],
  'top-center': ['center', 'top'],
  'top-right': ['right', 'top'],
  'middle-left': ['left', 'middle'],
  center: ['center', 'middle'],
  'middle-right': ['right', 'middle'],
  'bottom-left': ['left', 'bottom'],
  'bottom-center': ['center', 'bottom'],
  'bottom-right': ['right', 'bottom']
}

export function alignBox(bboxW, bboxH, pageW, pageH, pos, margin = 24) {
  if (!(bboxW > 0) || !(bboxH > 0) || !(pageW > 0) || !(pageH > 0)) throw new Error('尺寸无效')
  if (!Number.isFinite(margin) || margin < 0) throw new Error('边距无效')
  const p = BOX_POSITIONS[pos]
  if (!p) throw new Error('未知位置')
  const [hAlign, vAlign] = p
  const availW = pageW - 2 * margin
  const availH = pageH - 2 * margin
  if (availW < 1 || availH < 1) throw new Error('边距过大,页面可用区域不足')
  const x = hAlign === 'left' ? margin : hAlign === 'right' ? pageW - margin - bboxW : (pageW - bboxW) / 2
  const y = vAlign === 'bottom' ? margin : vAlign === 'top' ? pageH - margin - bboxH : (pageH - bboxH) / 2
  return { x, y }
}

// 拼版网格:返回行优先的格子列表,row 0 在最上方(PDF 的 y 轴向上)
export function nupCells(sheetW, sheetH, cols, rows, margin = 0, gap = 0) {
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error('拼版行列无效')
  }
  if (!(sheetW > 0) || !(sheetH > 0)) throw new Error('纸张尺寸无效')
  if (!Number.isFinite(margin) || margin < 0 || !Number.isFinite(gap) || gap < 0) {
    throw new Error('留白或间距无效')
  }
  const availW = sheetW - 2 * margin
  const availH = sheetH - 2 * margin
  const w = (availW - gap * (cols - 1)) / cols
  const h = (availH - gap * (rows - 1)) / rows
  if (w < 1 || h < 1) throw new Error('留白或间距过大,页面可用区域不足')
  const cells = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      cells.push({
        x: margin + col * (w + gap),
        y: margin + (rows - 1 - row) * (h + gap),
        w,
        h
      })
    }
  }
  return cells
}
