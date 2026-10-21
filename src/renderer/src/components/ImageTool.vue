<script setup>
import { ref } from 'vue'
import { PDFDocument } from 'pdf-lib'
import { fitRect, pageSize, resampleLongEdge } from '../utils/pdfLayout.js'

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/bmp': 'bmp' }
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' }
const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif'] }]
const IMAGE_EXT = /\.(png|jpe?g|bmp|gif)$/i

const files = ref([])
const format = ref('')
const scalePercent = ref('')
const maxEdge = ref('')
const rotateAngle = ref(30)
const quality = ref(80)
const busy = ref(false)
const progress = ref('')
const pdfPageSize = ref('a4') // a4 | a4p | letter | image
const pdfMargin = ref(24) // pt
const pdfDpi = ref(150)
const pdfQuality = ref(85)
const pdfSortByName = ref(false)

// 压缩到指定大小
const targetKb = ref(200)
// 裁剪 / 证件照
const cropMode = ref('margins')
const cropTop = ref(0)
const cropBottom = ref(0)
const cropLeft = ref(0)
const cropRight = ref(0)
const cropRatio = ref('1:1')
const cropPreset = ref('295x413')
// 拼长图
const stitchDirection = ref('vertical')
const stitchWidth = ref('')
const stitchHeight = ref('')
const stitchGap = ref(0)
const stitchBg = ref('white')
const stitchFormat = ref('png')
const stitchSortByName = ref(false)
const stitchNoUpscale = ref(false)
// 文字水印
const wmText = ref('内部资料')
const wmSize = ref(20)
const wmColor = ref('white')
const wmOpacity = ref(0.35)
const wmAngle = ref(0)
const wmPosition = ref('bottom-right')
const wmTile = ref(false)
const wmGap = ref(50)

const WM_COLORS = {
  white: '#ffffff',
  gray: '#888888',
  red: '#d02020',
  blue: '#2040d0',
  black: '#000000'
}
let wmCache = { key: '', data: null }

const splitName = (p) => {
  const name = p.split(/[\\/]/).pop()
  const dot = name.lastIndexOf('.')
  return { base: dot > 0 ? name.slice(0, dot) : name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }
}

// 路径驱动:渲染层只留路径与 240px 预览,原图字节由主进程按需读取
async function loadPaths(paths) {
  let total = 0
  for (const p of paths) {
    try {
      total += await window.api.fileSize(p)
    } catch {}
  }
  if (total > 150 * 1024 * 1024 &&
      !confirm(`所选图片合计约 ${(total / 1048576).toFixed(0)} MB,内存有限,处理可能较慢,继续?`)) {
    return
  }
  const picked = []
  for (const p of paths) {
    const { base, ext } = splitName(p)
    const item = { path: p, name: base, ext, size: 0, w: 0, h: 0, preview: '', noPreview: false, skipped: false }
    try {
      const preview = await window.api.previewImage(p)
      item.size = preview.size
      item.w = preview.width
      item.h = preview.height
      item.preview = preview.dataUrl
      item.noPreview = !preview.dataUrl
      item.skipped = Boolean(preview.skipped)
    } catch {
      item.noPreview = true
      try {
        item.size = await window.api.fileSize(p)
      } catch {}
    }
    picked.push(item)
  }
  if (picked.length) files.value = picked
}

async function pick() {
  const paths = await window.api.openFiles({ filters: IMAGE_FILTERS, multiple: true })
  if (!paths.length) return
  await loadPaths(paths)
}

function onDrop(e) {
  if (busy.value) return
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter((p) => IMAGE_EXT.test(p || ''))
  if (!paths.length) {
    alert('请拖入图片(png/jpg/jpeg/bmp/gif)。')
    return
  }
  loadPaths(paths)
}

function opFor(file) {
  const op = {}
  if (format.value) op.mime = MIME_BY_EXT[format.value]
  const s = Number(scalePercent.value)
  if (scalePercent.value !== '' && Number.isFinite(s) && s > 0) op.scalePercent = s
  const edge = Number(maxEdge.value)
  if (maxEdge.value !== '' && Number.isFinite(edge) && edge > 0) op.maxEdge = edge
  if (op.mime === 'image/jpeg') op.quality = Math.min(100, Math.max(1, Number(quality.value) || 80))
  return op
}

// 单文件走「另存为」,多文件先选目录再逐张处理并立即写盘,峰值只保留一张输出
async function processFiles(makeOp, suffix, label) {
  if (busy.value) return
  if (!files.value.length) {
    alert('请先选择图片。')
    return
  }
  busy.value = true
  try {
    if (files.value.length === 1) {
      const f = files.value[0]
      const { data, mime } = await window.api.processImageFile(f.path, await makeOp(f))
      // 以主进程实际产出的 mime 为准:目标大小模式会强制 JPEG
      const ext = EXT_BY_MIME[mime] || format.value || f.ext
      const target = await window.api.saveFile({ defaultName: `${f.name}${suffix}.${ext}`, filters: IMAGE_FILTERS })
      if (!target) return
      await window.api.writeFile(target, data)
      alert(`已保存:${target}`)
      return
    }
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const errors = []
    let written = 0
    for (let idx = 0; idx < files.value.length; idx += 1) {
      const f = files.value[idx]
      progress.value = `${label} ${idx + 1}/${files.value.length}`
      try {
        const { data, mime } = await window.api.processImageFile(f.path, await makeOp(f))
        const ext = EXT_BY_MIME[mime] || format.value || f.ext
        await window.api.writeUnique(dir, `${f.name}${suffix}.${ext}`, data)
        written += 1
      } catch (e) {
        errors.push({ name: f.name, message: e.message })
      }
    }
    if (errors.length) {
      alert(`已保存 ${written} 个,失败 ${errors.length} 个:\n${errors.slice(0, 5).map((e) => `${e.name}:${e.message}`).join('\n')}`)
    } else {
      alert(`已保存 ${written} 个文件到 ${dir}`)
    }
  } catch (e) {
    alert(`${label}失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

const apply = (rotate) => processFiles(
  (f) => {
    const op = opFor(f)
    if (rotate) op.rotate = rotate
    return op
  },
  rotate === -90 ? '_左旋' : rotate === 90 ? '_右旋' : rotate === 0 ? '_处理' : '_旋转',
  '正在处理'
)

function applyAngle() {
  const deg = Number(rotateAngle.value)
  if (!Number.isFinite(deg) || deg === 0) {
    alert('请输入非 0 的旋转角度。')
    return
  }
  apply(Math.max(-360, Math.min(360, deg)))
}

// 压缩:JPEG 走质量参数有损压缩;PNG 无损,仅重新编码
const compressImages = () => processFiles(() => ({ quality: Number(quality.value) || 80 }), '_压缩', '正在压缩')

function compressToTarget() {
  const kb = Number(targetKb.value)
  if (!Number.isFinite(kb) || kb < 1 || kb > 51200) {
    alert('目标大小需在 1–51200 KB 之间')
    return
  }
  return processFiles(() => ({ targetBytes: Math.round(kb * 1024) }), '_压缩KB', '正在压缩')
}

function cropOptions() {
  if (cropMode.value === 'margins') {
    return {
      type: 'margins',
      top: Number(cropTop.value) || 0,
      bottom: Number(cropBottom.value) || 0,
      left: Number(cropLeft.value) || 0,
      right: Number(cropRight.value) || 0
    }
  }
  if (cropMode.value === 'aspect') {
    const [w, h] = String(cropRatio.value).split(':').map(Number)
    if (!(w > 0) || !(h > 0)) throw new Error('裁剪比例无效')
    return { type: 'aspect', ratio: w / h }
  }
  const [w, h] = String(cropPreset.value).split('x').map(Number)
  if (!(w > 0) || !(h > 0)) throw new Error('证件照尺寸无效')
  return { type: 'preset', width: w, height: h }
}

function cropImages() {
  let crop
  try {
    crop = cropOptions()
  } catch (e) {
    alert(e.message)
    return
  }
  return processFiles(() => ({ crop }), '_裁剪', '正在裁剪')
}

async function stitchSelected() {
  if (busy.value) return
  if (files.value.length < 2) {
    alert('拼长图至少需要两张图片。')
    return
  }
  const list = stitchSortByName.value
    ? [...files.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    : [...files.value]
  const ext = stitchFormat.value === 'jpg' ? 'jpg' : 'png'
  const target = await window.api.saveFile({
    defaultName: `${list[0].name}_拼图.${ext}`,
    filters: IMAGE_FILTERS
  })
  if (!target) return
  const bg = stitchBg.value === 'black'
    ? 0x000000ff
    : stitchBg.value === 'transparent' ? 0x00000000 : 0xffffffff
  const opts = {
    direction: stitchDirection.value,
    gap: Number(stitchGap.value) || 0,
    background: bg,
    mime: ext === 'jpg' ? 'image/jpeg' : 'image/png',
    quality: Number(quality.value) || 85,
    noUpscale: stitchNoUpscale.value
  }
  if (stitchDirection.value === 'vertical' && String(stitchWidth.value).trim() !== '') {
    opts.width = Number(stitchWidth.value)
  }
  if (stitchDirection.value === 'horizontal' && String(stitchHeight.value).trim() !== '') {
    opts.height = Number(stitchHeight.value)
  }
  busy.value = true
  try {
    const result = await window.api.stitchImages(list.map((f) => f.path), opts, target)
    alert(`已保存:${target}\n${result.width}×${result.height} 像素,${Math.max(1, Math.round(result.size / 1024))} KB`)
  } catch (e) {
    alert(`拼长图失败:${e.message}`)
  } finally {
    busy.value = false
  }
}

// 主进程 Jimp 不支持中文 TTF,所以用渲染层 Canvas 把文字画成透明 PNG,
// 再交给主进程缩放/旋转/平铺/透明度合成。
async function buildWatermarkPng(text, color, targetPx) {
  const key = `${text}|${color}|${targetPx}`
  if (wmCache.key === key && wmCache.data) return wmCache.data
  const fontFor = (px) => `bold ${px}px "Microsoft YaHei", "SimHei", "SimSun", sans-serif`
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')
  let fontPx = Math.max(48, Math.min(512, Math.round(targetPx)))
  let width = 0
  let height = 0
  for (let i = 0; i < 6; i += 1) {
    measure.font = fontFor(fontPx)
    const pad = Math.round(fontPx * 0.15)
    width = Math.ceil(measure.measureText(text).width) + pad * 2
    height = Math.ceil(fontPx * 1.4) + pad * 2
    if (width <= 4096 && height <= 4096) break
    const scale = Math.min(4096 / width, 4096 / height)
    fontPx = Math.max(16, Math.floor(fontPx * scale))
  }
  if (width > 4096 || height > 4096) throw new Error('水印文字过长,请缩短后再试')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.font = fontFor(fontPx)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, width / 2, height / 2)
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('水印文字渲染失败'))), 'image/png')
  })
  const data = await blob.arrayBuffer()
  wmCache = { key, data }
  return data
}

async function watermarkImages() {
  if (busy.value) return
  if (!files.value.length) {
    alert('请先选择图片。')
    return
  }
  const text = String(wmText.value || '').trim().slice(0, 80)
  if (!text) {
    alert('请输入水印文字。')
    return
  }
  const pct = Math.min(100, Math.max(1, Number(wmSize.value) || 20))
  const maxW = Math.max(...files.value.map((f) => f.w || 0)) || 1200
  const targetPx = Math.min(2048, Math.max(64, Math.round((maxW * pct) / 100 * 2)))
  let png
  try {
    png = await buildWatermarkPng(text, WM_COLORS[wmColor.value] || '#ffffff', targetPx)
  } catch (e) {
    alert(`生成水印失败:${e.message}`)
    return
  }
  const watermark = {
    png,
    widthPercent: pct,
    opacity: Math.min(1, Math.max(0.02, Number(wmOpacity.value) || 0.35)),
    angle: Number(wmAngle.value) || 0,
    position: wmPosition.value,
    tile: wmTile.value,
    gapPercent: Math.max(10, Number(wmGap.value) || 50)
  }
  return processFiles(() => ({ watermark }), '_水印', '正在加水印')
}

// 每张图一页:固定页面时等比适应页内并居中,再按 DPI 重采样;「原图像素」直接嵌原字节
async function imagesToPdf() {
  if (busy.value) return
  if (!files.value.length) {
    alert('请先选择图片。')
    return
  }
  const list = pdfSortByName.value
    ? [...files.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    : files.value
  const margin = Math.min(72, Math.max(0, Number(pdfMargin.value) || 0))
  const dpi = Math.min(600, Math.max(72, Number(pdfDpi.value) || 150))
  const quality = Math.min(100, Math.max(1, Number(pdfQuality.value) || 85))
  const target = await window.api.saveFile({
    defaultName: `${list[0].name}.pdf`,
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  })
  if (!target) return
  busy.value = true
  try {
    const doc = await PDFDocument.create()
    const errors = []
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i]
      progress.value = `正在合成 ${i + 1}/${list.length}`
      try {
        const isJpeg = f.ext === 'jpg' || f.ext === 'jpeg'
        const isPng = f.ext === 'png'
        const [pw, ph] = pageSize(pdfPageSize.value, f.w || 1, f.h || 1, margin)
        // 原图像素模式不重采样;预览被跳过(f.w/f.h 为 0)时也跳过,页面仍按嵌入后的真实尺寸算
        const maxEdge = pdfPageSize.value === 'image' || !(f.w > 0 && f.h > 0)
          ? null
          : resampleLongEdge(pw, ph, margin, dpi, f.w, f.h)
        let img
        if ((isJpeg || isPng) && !maxEdge) {
          // 不需要重编码:直嵌原字节,画质与体积都保持原样
          const bytes = await window.api.readFile(f.path)
          img = isJpeg ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
        } else {
          const op = { mime: isJpeg ? 'image/jpeg' : 'image/png', maxEdge }
          if (isJpeg) op.quality = quality
          const { data } = await window.api.processImageFile(f.path, op)
          img = isJpeg ? await doc.embedJpg(data) : await doc.embedPng(data)
        }
        const [w, h] = pageSize(pdfPageSize.value, img.width, img.height, margin)
        doc.addPage([w, h]).drawImage(img, fitRect(img.width, img.height, w, h, margin))
      } catch (e) {
        // pdf-lib 的 PNG 解析器抛的是字符串,没有 message
        errors.push({ name: f.name, message: (e && e.message) || String(e) })
      }
    }
    if (errors.length === list.length) {
      alert(`合成 PDF 失败:${errors[0].message}`)
      return
    }
    await window.api.writeFile(target, await doc.save())
    if (errors.length) {
      alert(`已生成 PDF:${target}\n有 ${errors.length} 张失败:\n${errors.slice(0, 5).map((e) => `${e.name}:${e.message}`).join('\n')}`)
    } else {
      alert(`已生成 PDF:${target}`)
    }
  } catch (e) {
    alert(`合成 PDF 失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

const clearAll = () => {
  files.value = []
  progress.value = ''
}
</script>

<template>
  <div class="tool" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" :disabled="busy" @click="pick">选择图片</button>
      <button class="act" @click="clearAll">清空</button>
      <label>格式
        <select v-model="format">
          <option value="">保持原格式</option>
          <option value="png">PNG</option>
          <option value="jpg">JPEG</option>
          <option value="bmp">BMP</option>
        </select>
      </label>
      <label>缩放 %
        <input v-model="scalePercent" type="number" min="1" max="400" style="width: 96px" placeholder="留空不缩放" />
      </label>
      <label>最大边长 px
        <input v-model="maxEdge" type="number" min="16" max="20000" style="width: 104px" placeholder="留空不限" />
      </label>
      <label>JPEG 质量
        <input v-model="quality" type="number" min="1" max="100" style="width: 70px" />
      </label>
      <span class="hint">处理后另存为新文件,原图不动;输出自动加 _左旋/_右旋/_旋转/_处理/_压缩 后缀,重名自动加 -1 后缀</span>
    </div>

    <div v-if="files.length" class="imgrid">
      <div v-for="f in files" :key="f.path" class="imgcard">
        <img v-if="f.preview" :src="f.preview" :alt="f.name" />
        <div v-else class="imgph">{{ f.noPreview ? (f.skipped ? '大图不预览' : '无法预览') : '…' }}</div>
        <div class="imgname">{{ f.name }}.{{ f.ext }}</div>
        <div class="hint">{{ f.w ? `${f.w}×${f.h} · ` : '' }}{{ Math.max(1, Math.round(f.size / 1024)) }} KB</div>
      </div>
    </div>

    <div class="row">
      <label>PDF 页面
        <select v-model="pdfPageSize">
          <option value="a4">A4(自动横竖)</option>
          <option value="a4p">A4 竖向</option>
          <option value="letter">Letter(自动横竖)</option>
          <option value="image">原图像素</option>
        </select>
      </label>
      <label>留白 pt
        <input v-model="pdfMargin" type="number" min="0" max="72" style="width: 76px" />
      </label>
      <label>图片 DPI
        <input v-model="pdfDpi" type="number" min="72" max="600" :disabled="pdfPageSize === 'image'" style="width: 84px" />
      </label>
      <label>JPEG 质量
        <input v-model="pdfQuality" type="number" min="1" max="100" style="width: 70px" />
      </label>
      <label><input v-model="pdfSortByName" type="checkbox" /> 按文件名排序</label>
      <span class="hint">每张图一页,等比适应页内并居中;A4/Letter 按 DPI 重采样,单页不超过 3000 万像素</span>
    </div>

    <div class="row">
      <button class="act" :disabled="busy" @click="apply(-90)">左旋 90° 并保存</button>
      <button class="act" :disabled="busy" @click="apply(90)">右旋 90° 并保存</button>
      <label>角度(顺时针°)
        <input v-model="rotateAngle" type="number" min="-360" max="360" step="1" style="width: 75px" />
      </label>
      <button class="act" :disabled="busy" @click="applyAngle">按角度旋转并保存</button>
      <button class="act" :disabled="busy" @click="apply(0)">按当前参数保存</button>
      <button class="act" :disabled="busy" @click="compressImages">压缩</button>
      <button class="act" :disabled="busy" @click="imagesToPdf">合成 PDF</button>
      <span class="hint">角度负数为逆时针;旋转后空白角在 JPG 中会铺白</span>
      <span class="hint">合成 PDF 默认按列表顺序,可勾选"按文件名排序"</span>
      <span class="hint">{{ progress }}</span>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-title">压缩到指定大小</div>
        <div class="row">
          <label>目标 KB
            <input v-model="targetKb" type="number" min="1" max="51200" style="width: 100px" />
          </label>
          <button class="act" :disabled="busy" @click="compressToTarget">压缩并保存</button>
        </div>
        <div class="hint">自动迭代 JPEG 质量,必要时降低分辨率;透明图会铺白底</div>
      </div>

      <div class="card">
        <div class="card-title">裁剪 / 证件照</div>
        <div class="row">
          <label>方式
            <select v-model="cropMode">
              <option value="margins">按边距</option>
              <option value="aspect">按比例</option>
              <option value="preset">证件照</option>
            </select>
          </label>
          <template v-if="cropMode === 'margins'">
            <label>上 <input v-model="cropTop" type="number" min="0" style="width: 62px" /></label>
            <label>下 <input v-model="cropBottom" type="number" min="0" style="width: 62px" /></label>
            <label>左 <input v-model="cropLeft" type="number" min="0" style="width: 62px" /></label>
            <label>右 <input v-model="cropRight" type="number" min="0" style="width: 62px" /></label>
          </template>
          <label v-else-if="cropMode === 'aspect'">比例
            <select v-model="cropRatio">
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
            </select>
          </label>
          <label v-else>尺寸
            <select v-model="cropPreset">
              <option value="295x413">一寸 295×413</option>
              <option value="413x579">二寸 413×579</option>
              <option value="260x378">小一寸 260×378</option>
              <option value="390x567">大一寸 390×567</option>
            </select>
          </label>
          <button class="act" :disabled="busy" @click="cropImages">裁剪并保存</button>
        </div>
        <div class="hint">比例裁剪居中;证件照裁剪后缩放到精确像素</div>
      </div>

      <div class="card wide">
        <div class="card-title">拼长图</div>
        <div class="row">
          <label>方向
            <select v-model="stitchDirection">
              <option value="vertical">纵向</option>
              <option value="horizontal">横向</option>
            </select>
          </label>
          <label v-if="stitchDirection === 'vertical'">统一宽度 px
            <input v-model="stitchWidth" type="number" min="1" max="20000" style="width: 100px" placeholder="留空=最宽图" />
          </label>
          <label v-else>统一高度 px
            <input v-model="stitchHeight" type="number" min="1" max="20000" style="width: 100px" placeholder="留空=最高图" />
          </label>
          <label>间距 px
            <input v-model="stitchGap" type="number" min="0" max="500" style="width: 70px" />
          </label>
          <label>背景
            <select v-model="stitchBg">
              <option value="white">白色</option>
              <option value="black">黑色</option>
              <option value="transparent">透明</option>
            </select>
          </label>
          <label>格式
            <select v-model="stitchFormat">
              <option value="png">PNG</option>
              <option value="jpg">JPEG</option>
            </select>
          </label>
          <label><input v-model="stitchSortByName" type="checkbox" /> 按文件名排序</label>
          <label><input v-model="stitchNoUpscale" type="checkbox" /> 小图不放大(居中留白)</label>
          <button class="act" :disabled="busy" @click="stitchSelected">拼成一张并保存</button>
        </div>
        <div class="hint">总像素不超过 3000 万、单边不超过 20000;JPEG 背景会强制为白色</div>
      </div>

      <div class="card wide">
        <div class="card-title">文字水印</div>
        <div class="row">
          <label>文字
            <input v-model="wmText" type="text" style="width: 160px" placeholder="内部资料" />
          </label>
          <label>字号(占图宽 %)
            <input v-model="wmSize" type="number" min="1" max="100" style="width: 70px" />
          </label>
          <label>颜色
            <select v-model="wmColor">
              <option value="white">白</option>
              <option value="gray">灰</option>
              <option value="red">红</option>
              <option value="blue">蓝</option>
              <option value="black">黑</option>
            </select>
          </label>
          <label>透明度
            <input v-model.number="wmOpacity" type="range" min="0.05" max="1" step="0.05" />
            {{ Math.round(wmOpacity * 100) }}%
          </label>
          <label>角度
            <select v-model.number="wmAngle">
              <option :value="0">0°</option>
              <option :value="30">30°</option>
              <option :value="45">45°</option>
              <option :value="90">90°</option>
              <option :value="-45">-45°</option>
            </select>
          </label>
          <label>位置
            <select v-model="wmPosition">
              <option value="top-left">左上</option>
              <option value="top-center">上中</option>
              <option value="top-right">右上</option>
              <option value="middle-left">左中</option>
              <option value="center">居中</option>
              <option value="middle-right">右中</option>
              <option value="bottom-left">左下</option>
              <option value="bottom-center">下中</option>
              <option value="bottom-right">右下</option>
            </select>
          </label>
          <label><input v-model="wmTile" type="checkbox" /> 平铺</label>
          <label v-if="wmTile">间距 %
            <input v-model="wmGap" type="number" min="10" max="500" style="width: 70px" />
          </label>
          <button class="act" :disabled="busy" @click="watermarkImages">加水印并保存</button>
        </div>
        <div class="hint">中文文字在渲染层用系统字体绘制;不勾平铺时按 9 宫格放一个</div>
      </div>
    </div>
  </div>
</template>
