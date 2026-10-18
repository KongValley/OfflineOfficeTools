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
      const { data, mime } = await window.api.processImageFile(f.path, makeOp(f))
      const ext = format.value || EXT_BY_MIME[mime] || f.ext
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
        const { data, mime } = await window.api.processImageFile(f.path, makeOp(f))
        const ext = format.value || EXT_BY_MIME[mime] || f.ext
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
  </div>
</template>
