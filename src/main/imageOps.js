const fs = require('fs')
const zlib = require('zlib')
const Jimp = require('jimp')
const jpeg = require('jpeg-js')

// Jimp 给 jpeg-js 的默认解码预算是 512MB,30MP 照片(约 120MB RGBA 加中间缓冲)会直接报
// "maxMemoryUsageInMB limit exceeded"。这里按 4800 万像素的读入上限留足预算,
// 并把超预算错误换成中文提示,避免英文库错误直接弹到界面。
const JPEG_DECODE_BUDGET_MB = 1024
Jimp.decoders[Jimp.MIME_JPEG] = (data) => {
  try {
    return jpeg.decode(data, { maxMemoryUsageInMB: JPEG_DECODE_BUDGET_MB })
  } catch (error) {
    if (/maxMemoryUsageInMB/.test(String((error && error.message) || error))) {
      throw new Error('图片过大,内存不足,请先缩小尺寸或降低分辨率')
    }
    throw error
  }
}

const MAX_IMAGE_PIXELS = 30000000    // 最终尺寸上限(约 120MB RGBA)
const MAX_IMAGE_SIDE = 20000         // 单边上限
const MAX_SOURCE_PIXELS = 48000000   // 读入上限(约 190MB RGBA,4800 万像素)
const MAX_EMBEDDED_PIXELS = 36000000 // PDF 内嵌图解码上限(600 DPI A4 约 3490 万像素)

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

// 解码前从文件头读 PNG/JPEG/BMP/GIF 尺寸,避免超大图在 Jimp 解码阶段就吃满内存
function imageDimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  return null
}

// 按 /Filter 与尺寸解码 PDF 内嵌图为 Jimp 实例;裸采样按 Gray/RGB 展开。
// 渲染层只在压缩时把 u8 数据送到这里,拿回的是成品 JPEG,不再持有 RGBA。
async function decodeEmbeddedImage(data, opts = {}) {
  const filters = opts.filters || []
  const unsupported = filters.find((f) => !['DCTDecode', 'FlateDecode'].includes(f))
  if (unsupported) throw new Error(`不支持的图像过滤器:${unsupported}`)
  const isDct = filters.includes('DCTDecode')
  const hasRawSamples = Boolean(opts.width && opts.height)
  if (!isDct && hasRawSamples) {
    const { width, height } = opts
    if (width * height > MAX_EMBEDDED_PIXELS) throw new Error('图像过大(超过 3600 万像素),已跳过')
    let buf = Buffer.from(data)
    if (filters.includes('FlateDecode')) buf = zlib.inflateSync(buf)
    const channels = opts.colorSpace === '/DeviceGray' ? 1 : 3
    if (buf.length < width * height * channels) throw new Error('图像数据长度不足')
    const rgba = Buffer.alloc(width * height * 4, 255)
    for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
      rgba[j] = buf[i * channels]
      rgba[j + 1] = buf[i * channels + (channels === 1 ? 0 : 1)]
      rgba[j + 2] = buf[i * channels + (channels === 1 ? 0 : 2)]
    }
    // 裸采样不是封装格式,Jimp.read 只认文件头,必须直接构造位图
    return new Jimp({ data: rgba, width, height })
  }
  const buf = Buffer.from(data)
  const dim = imageDimensions(buf)
  if (dim && dim.width * dim.height > MAX_EMBEDDED_PIXELS) {
    throw new Error('图像过大(超过 3600 万像素),已跳过')
  }
  const image = await Jimp.read(buf)
  if (image.bitmap.width * image.bitmap.height > MAX_EMBEDDED_PIXELS) {
    throw new Error('图像过大(超过 3600 万像素),已跳过')
  }
  return image
}

function intInRange(value, min, max, message) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(message)
  return n
}

// 裁剪:边距 / 比例 / 证件照预设(预设会缩放到精确像素)
function applyCrop(image, crop) {
  if (!crop || typeof crop !== 'object') throw new Error('裁剪参数无效')
  const W = image.bitmap.width
  const H = image.bitmap.height
  let rect
  let resizeTo = null

  if (crop.type === 'margins') {
    const top = intInRange(crop.top ?? 0, 0, MAX_IMAGE_SIDE, '上边距无效')
    const bottom = intInRange(crop.bottom ?? 0, 0, MAX_IMAGE_SIDE, '下边距无效')
    const left = intInRange(crop.left ?? 0, 0, MAX_IMAGE_SIDE, '左边距无效')
    const right = intInRange(crop.right ?? 0, 0, MAX_IMAGE_SIDE, '右边距无效')
    if (W - left - right < 1 || H - top - bottom < 1) throw new Error('裁剪边距过大,图片没有剩余内容')
    rect = { x: left, y: top, w: W - left - right, h: H - top - bottom }
  } else if (crop.type === 'aspect') {
    const ratio = Number(crop.ratio)
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('裁剪比例无效')
    if (W / H > ratio) {
      const w = Math.max(1, Math.round(H * ratio))
      rect = { x: Math.floor((W - w) / 2), y: 0, w, h: H }
    } else {
      const h = Math.max(1, Math.round(W / ratio))
      rect = { x: 0, y: Math.floor((H - h) / 2), w: W, h }
    }
  } else if (crop.type === 'preset') {
    const pw = intInRange(crop.width, 16, MAX_IMAGE_SIDE, '证件照宽度需在 16–20000 像素之间')
    const ph = intInRange(crop.height, 16, MAX_IMAGE_SIDE, '证件照高度需在 16–20000 像素之间')
    if (pw * ph > MAX_IMAGE_PIXELS) throw new Error('证件照尺寸超出 3000 万像素限制')
    const ratio = pw / ph
    if (W / H > ratio) {
      const w = Math.max(1, Math.round(H * ratio))
      rect = { x: Math.floor((W - w) / 2), y: 0, w, h: H }
    } else {
      const h = Math.max(1, Math.round(W / ratio))
      rect = { x: 0, y: Math.floor((H - h) / 2), w: W, h }
    }
    resizeTo = [pw, ph]
  } else {
    throw new Error('未知的裁剪方式')
  }

  image.crop(rect.x, rect.y, rect.w, rect.h)
  if (resizeTo) image.resize(resizeTo[0], resizeTo[1])
}

function positionXY(pos, W, H, bboxW, bboxH, margin) {
  const left = pos.endsWith('left')
  const right = pos.endsWith('right')
  const top = pos.startsWith('top')
  const bottom = pos.startsWith('bottom')
  const x = left ? margin : right ? W - margin - bboxW : Math.floor((W - bboxW) / 2)
  const y = top ? margin : bottom ? H - margin - bboxH : Math.floor((H - bboxH) / 2)
  return { x, y }
}

// 水印文字由渲染层 Canvas 画成透明 PNG;这里只做缩放/旋转/平铺/透明度合成
async function applyWatermark(image, wm) {
  if (!wm || !wm.png) throw new Error('水印图片无效')
  let stamp
  try {
    stamp = await Jimp.read(Buffer.from(wm.png))
  } catch {
    throw new Error('水印文字渲染失败,请换一段文字重试')
  }
  const W = image.bitmap.width
  const H = image.bitmap.height
  const pct = Number(wm.widthPercent)
  const widthPct = Number.isFinite(pct) ? Math.min(100, Math.max(1, pct)) : 20
  const targetW = Math.min(W, Math.max(4, Math.round((W * widthPct) / 100)))
  const scale = targetW / stamp.bitmap.width
  stamp.resize(targetW, Math.max(1, Math.round(stamp.bitmap.height * scale)))

  const angle = Number(wm.angle) || 0
  if (angle) {
    stamp.background(0x00000000)
    stamp.rotate(angle)
  }
  const opacityRaw = Number(wm.opacity)
  const opacity = Number.isFinite(opacityRaw) ? Math.min(1, Math.max(0.02, opacityRaw)) : 0.35

  if (wm.tile) {
    const gapPct = Number(wm.gapPercent)
    const gap = Math.max(8, Math.round((stamp.bitmap.height * (Number.isFinite(gapPct) ? gapPct : 50)) / 100))
    const stepX = stamp.bitmap.width + gap
    const stepY = stamp.bitmap.height + gap
    for (let y = -stamp.bitmap.height; y < H + stamp.bitmap.height; y += stepY) {
      for (let x = -stamp.bitmap.width; x < W + stamp.bitmap.width; x += stepX) {
        image.composite(stamp, x, y, { opacitySource: opacity })
      }
    }
  } else {
    const margin = Math.max(4, Math.round(Math.min(W, H) * 0.03))
    const pos = typeof wm.position === 'string' ? wm.position : 'bottom-right'
    const { x, y } = positionXY(pos, W, H, stamp.bitmap.width, stamp.bitmap.height, margin)
    image.composite(stamp, x, y, { opacitySource: opacity })
  }
}

async function bestJpegUnder(image, target) {
  let lo = 1
  let hi = 95
  let best = null
  while (lo <= hi) {
    const q = (lo + hi) >> 1
    image.quality(q)
    const buf = await image.getBufferAsync(Jimp.MIME_JPEG)
    if (buf.length <= target) {
      best = buf
      lo = q + 1
    } else {
      hi = q - 1
    }
  }
  return best
}

// 目标大小:先二分 JPEG 质量;仍超标则按 0.85 逐步降分辨率
// 32 位进程里反复整图编码 30MP 会耗尽 V8 堆,先按目标大小降到工作像素内再搜索。
const TARGET_SEARCH_MAX_PIXELS = 12000000
async function compressToTarget(image, targetBytes) {
  const target = Math.trunc(Number(targetBytes))
  if (!Number.isFinite(target) || target < 1024 || target > 50 * 1024 * 1024) {
    throw new Error('目标大小需在 1 KB–50 MB 之间')
  }
  const pixels = image.bitmap.width * image.bitmap.height
  const budget = Math.min(TARGET_SEARCH_MAX_PIXELS, Math.max(1000000, target * 2))
  if (pixels > budget) {
    const scale = Math.sqrt(budget / pixels)
    image.resize(
      Math.max(1, Math.round(image.bitmap.width * scale)),
      Math.max(1, Math.round(image.bitmap.height * scale))
    )
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const buf = await bestJpegUnder(image, target)
    if (buf) return buf
    const w = image.bitmap.width
    const h = image.bitmap.height
    if (Math.min(w, h) <= 32) break
    image.resize(Math.max(1, Math.round(w * 0.85)), Math.max(1, Math.round(h * 0.85)))
  }
  throw new Error(`无法压缩到 ${Math.max(1, Math.round(target / 1024))} KB,请增大目标大小或换用更小的图片`)
}

// image:processFile 的共用逻辑:旋转(正=界面顺时针)、裁剪、最大边、百分比缩放、水印、目标大小
async function processJimp(image, op = {}) {
  if (image.bitmap.width * image.bitmap.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片超过 4800 万像素,已拒绝处理')
  }
  // 未指定目标格式时保持源格式:否则 JPEG 会被重编码成 PNG,体积反而暴涨;
  // GIF 同理:jimp 只读首帧且不支持写 GIF,退回 PNG
  const sourceMime = image.getMIME()
  let mime = op.targetBytes != null
    ? Jimp.MIME_JPEG
    : op.mime || (sourceMime === 'image/gif' ? Jimp.MIME_PNG : sourceMime)
  // jimp 的 background 会在 rotate/编码时用来填空白角;JPEG 不支持透明,先铺白避免黑角
  if (mime === Jimp.MIME_JPEG) image.background(0xffffffff)
  // jimp 的第二个参数是 resize:传 false 会保持原画布尺寸,旋转后的内容会被裁掉
  // jimp 的正角度是逆时针(rotate(+90) 让右上角落到左上角),而界面上的"右旋"是顺时针,
  // 所以这里取负号,让界面语义与实际方向一致
  if (op.rotate) {
    const deg = Number(op.rotate)
    if (!Number.isFinite(deg)) throw new Error('旋转角度无效')
    image.rotate(-deg)
  }
  if (op.crop) applyCrop(image, op.crop)
  if (op.maxEdge) {
    const edge = Number(op.maxEdge)
    if (!Number.isFinite(edge) || edge < 16 || edge > MAX_IMAGE_SIDE) {
      throw new Error('最大边长需在 16–20000 像素之间')
    }
    const longest = Math.max(image.bitmap.width, image.bitmap.height)
    if (longest > edge) {
      const scale = edge / longest
      image.resize(
        Math.max(1, Math.round(image.bitmap.width * scale)),
        Math.max(1, Math.round(image.bitmap.height * scale))
      )
    }
  }
  if (op.scalePercent) {
    const percent = Number(op.scalePercent)
    if (!Number.isFinite(percent) || percent < 1 || percent > 400) {
      throw new Error('缩放比例需在 1%–400% 之间')
    }
    const w = Math.max(1, Math.round((image.bitmap.width * percent) / 100))
    const h = Math.max(1, Math.round((image.bitmap.height * percent) / 100))
    image.resize(w, h)
  }
  // 目标大小模式允许把超大图先压到预算内,而不是直接拒绝
  if (op.targetBytes != null && image.bitmap.width * image.bitmap.height > MAX_IMAGE_PIXELS) {
    const scale = Math.sqrt(MAX_IMAGE_PIXELS / (image.bitmap.width * image.bitmap.height))
    image.resize(
      Math.max(1, Math.round(image.bitmap.width * scale)),
      Math.max(1, Math.round(image.bitmap.height * scale))
    )
  }
  if (
    image.bitmap.width > MAX_IMAGE_SIDE ||
    image.bitmap.height > MAX_IMAGE_SIDE ||
    image.bitmap.width * image.bitmap.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('图片尺寸超出限制(单边 20000 像素或 3000 万像素)')
  }
  if (op.watermark) await applyWatermark(image, op.watermark)
  if (op.targetBytes != null) {
    const buf = await compressToTarget(image, op.targetBytes)
    return { data: toArrayBuffer(buf), mime: Jimp.MIME_JPEG }
  }
  if (op.quality != null && mime === Jimp.MIME_JPEG) image.quality(op.quality)
  const buf = await image.getBufferAsync(mime)
  return { data: toArrayBuffer(buf), mime }
}

function normalizeBackground(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) throw new Error('背景色无效')
  return Math.trunc(n) >>> 0
}

// 拼长图:第一遍只读尺寸,分配一次画布;第二遍逐张解码/缩放/合成,峰值只多一张源图
async function stitchImages(paths, opts = {}, targetPath) {
  if (!Array.isArray(paths) || paths.length < 2) throw new Error('拼长图至少需要两张图片')
  if (typeof targetPath !== 'string' || !targetPath) throw new Error('缺少输出路径')
  const direction = opts.direction === 'horizontal' ? 'horizontal' : 'vertical'
  const noUpscale = opts.noUpscale === true
  const gap = intInRange(opts.gap ?? 0, 0, 500, '间距需在 0–500 像素之间')
  let background = normalizeBackground(opts.background == null ? 0xffffffff : opts.background)
  const mime = opts.mime === 'image/jpeg' ? Jimp.MIME_JPEG : Jimp.MIME_PNG
  if (mime === Jimp.MIME_JPEG) background = 0xffffffff

  const metas = []
  for (const p of paths) {
    if (typeof p !== 'string' || !p) throw new Error('图片路径无效')
    const buf = fs.readFileSync(p)
    let dim = imageDimensions(buf)
    if (!dim) {
      const img = await Jimp.read(buf)
      dim = { width: img.bitmap.width, height: img.bitmap.height }
    }
    if (!dim || !(dim.width > 0) || !(dim.height > 0)) throw new Error(`无法读取图片:${p}`)
    if (dim.width * dim.height > MAX_SOURCE_PIXELS) throw new Error(`「${p}」超过 4800 万像素,已拒绝处理`)
    metas.push({ path: p, w: dim.width, h: dim.height })
  }

  let totalW
  let totalH
  const items = []
  if (direction === 'vertical') {
    totalW = opts.width == null || opts.width === ''
      ? Math.max(...metas.map((m) => m.w))
      : intInRange(opts.width, 1, MAX_IMAGE_SIDE, '统一宽度需在 1–20000 像素之间')
    let y = 0
    for (const m of metas) {
      let w
      let h
      let x = 0
      if (noUpscale && m.w <= totalW) {
        w = m.w
        h = m.h
        x = Math.round((totalW - w) / 2)
      } else {
        const scale = totalW / m.w
        w = totalW
        h = Math.max(1, Math.round(m.h * scale))
      }
      items.push({ path: m.path, x, y, w, h })
      y += h + gap
    }
    totalH = y - gap
  } else {
    totalH = opts.height == null || opts.height === ''
      ? Math.max(...metas.map((m) => m.h))
      : intInRange(opts.height, 1, MAX_IMAGE_SIDE, '统一高度需在 1–20000 像素之间')
    let x = 0
    for (const m of metas) {
      let w
      let h
      let y = 0
      if (noUpscale && m.h <= totalH) {
        w = m.w
        h = m.h
        y = Math.round((totalH - h) / 2)
      } else {
        const scale = totalH / m.h
        w = Math.max(1, Math.round(m.w * scale))
        h = totalH
      }
      items.push({ path: m.path, x, y, w, h })
      x += w + gap
    }
    totalW = x - gap
  }

  if (totalW < 1 || totalH < 1 || totalW > MAX_IMAGE_SIDE || totalH > MAX_IMAGE_SIDE) {
    throw new Error(`拼图结果 ${totalW}×${totalH} 超出单边 20000 像素限制,请减小统一尺寸或减少图片`)
  }
  const pixels = totalW * totalH
  if (pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`拼图结果约 ${(pixels / 1e6).toFixed(1)} 百万像素,超过 3000 万像素限制,请减小统一尺寸或减少图片`)
  }

  const out = new Jimp(totalW, totalH, background)
  for (const item of items) {
    const img = await Jimp.read(fs.readFileSync(item.path))
    if (img.bitmap.width !== item.w || img.bitmap.height !== item.h) img.resize(item.w, item.h)
    out.composite(img, item.x, item.y)
  }
  if (mime === Jimp.MIME_JPEG) out.quality(intInRange(opts.quality ?? 85, 1, 100, 'JPEG 质量需在 1–100 之间'))
  const buf = await out.getBufferAsync(mime)
  fs.writeFileSync(targetPath, buf)
  return { width: totalW, height: totalH, size: buf.length, mime }
}

module.exports = {
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_SOURCE_PIXELS,
  MAX_EMBEDDED_PIXELS,
  toArrayBuffer,
  imageDimensions,
  decodeEmbeddedImage,
  processJimp,
  stitchImages
}
