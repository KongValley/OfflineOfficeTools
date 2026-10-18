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
