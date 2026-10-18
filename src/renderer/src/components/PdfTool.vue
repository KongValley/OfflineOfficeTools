<script setup>
import { ref, computed, nextTick, onUnmounted } from 'vue'
import { PDFDocument, degrees, PDFName, PDFRawStream, PDFArray, PDFDict, PDFNumber, PDFRef } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import { parsePageRange, splitPageSegments, formatPageRange } from '../utils/pageRange.js'
import { isCompressibleImage } from '../utils/pdfImage.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const PDF_FILTERS = [{ name: 'PDF 文件', extensions: ['pdf'] }]
// 单页导出像素上限,与主进程 MAX_IMAGE_PIXELS 同量级(A4 600 DPI ≈ 34.8MP,约 139MB RGBA)
const MAX_EXPORT_PIXELS = 30000000
const files = ref([])
const range = ref('')
const targetDpi = ref(150)
const busy = ref(false)
const pngDpi = ref(150)
const pngFormat = ref('png')
const pngQuality = ref(85)
const splitMode = ref('segments')
const everyN = ref(1)
const reorderMode = ref(false)
const reorderPicks = ref([])
const thumbs = ref([])          // { page: 0-based, src: dataURL, error: bool }
const thumbProgress = ref('')
const thumbError = ref('')
const progress = ref('')
const anchor = ref(null)        // Shift 连选锚点
const thumbGrid = ref(null)
let thumbToken = 0
let thumbObserver = null
let pdfDoc = null
let thumbQueue = Promise.resolve()
let thumbPending = 0

const baseName = (p) => p.split(/[\\/]/).pop()

const pageCount = computed(() => files.value[0]?.pageCount || 0)
const selectedPages = computed(() => parsePageRange(range.value, pageCount.value) || [])
const selectedSet = computed(() => new Set(selectedPages.value))

// PDFNumber 的取值方法是 asNumber();v.value 是已废弃的方法而非属性,不能当数值用
const num = (dict, key) => {
  const v = dict.get(PDFName.of(key))
  return v && typeof v.asNumber === 'function' ? v.asNumber() : null
}

// 估算图片在页面上的显示 DPI:72 pt = 1 inch。
// 只在图片直接挂在某页 /Resources/XObject 下时可靠,间接引用返回 null(不缩放)
const estimateDpi = (doc, ref, pxWidth) => {
  for (const page of doc.getPages()) {
    const resources = page.node.get(PDFName.of('Resources'))
    if (!(resources instanceof PDFDict)) continue
    const xobjects = resources.get(PDFName.of('XObject'))
    if (!(xobjects instanceof PDFDict)) continue
    for (const [, value] of xobjects.entries()) {
      if (value !== ref) continue
      const mediaBox = page.node.get(PDFName.of('MediaBox'))
      if (!(mediaBox instanceof PDFArray)) return null
      const pageWidth = Math.abs(mediaBox.get(2).asNumber() - mediaBox.get(0).asNumber())
      return pageWidth > 0 ? Math.round((pxWidth * 72) / pageWidth) : null
    }
  }
  return null
}

async function pick() {
  const paths = await window.api.openFiles({ filters: PDF_FILTERS, multiple: true })
  if (!paths.length) return
  await loadPaths(paths)
}

async function loadPaths(paths) {
  let total = 0
  for (const p of paths) {
    try {
      total += await window.api.fileSize(p)
    } catch {}
  }
  if (total > 200 * 1024 * 1024 &&
      !confirm(`所选 PDF 合计约 ${(total / 1048576).toFixed(0)} MB,内存有限,处理可能较慢,继续?`)) {
    return
  }
  const picked = []
  for (const p of paths) {
    try {
      const data = await window.api.readFile(p)
      const doc = await PDFDocument.load(data)
      const full = baseName(p)
      picked.push({ path: p, name: full, stem: full.replace(/\.pdf$/i, ''), pageCount: doc.getPageCount(), data })
    } catch (e) {
      alert(`无法读取「${baseName(p)}」:${e.message}\n该 PDF 可能已加密或已损坏。`)
    }
  }
  if (picked.length) {
    files.value = picked
    range.value = ''
    anchor.value = null
    reorderMode.value = false
    reorderPicks.value = []
    loadThumbs(picked[0])
  }
}

function onDrop(e) {
  if (busy.value) return
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter((p) => /\.pdf$/i.test(p || ''))
  if (!paths.length) {
    alert('请拖入 PDF 文件。')
    return
  }
  loadPaths(paths)
}

// 缩略图只在滚入可视区时按需渲染(页数很多时不浪费 CPU);同屏多页串行渲染,内存只留 dataURL
function cleanupThumbs() {
  thumbToken += 1
  if (thumbObserver) {
    thumbObserver.disconnect()
    thumbObserver = null
  }
  if (pdfDoc) {
    pdfDoc.destroy().catch(() => {})
    pdfDoc = null
  }
  thumbPending = 0
  thumbProgress.value = ''
}

async function loadThumbs(file) {
  cleanupThumbs()
  const token = thumbToken
  thumbs.value = Array.from({ length: file.pageCount }, (_, i) => ({ page: i, src: '', error: false }))
  thumbError.value = ''
  if (!file.pageCount) return
  try {
    const doc = await pdfjsLib.getDocument({ data: file.data.slice(0) }).promise
    if (token !== thumbToken) {
      doc.destroy().catch(() => {})
      return
    }
    pdfDoc = doc
    await nextTick()
    const grid = thumbGrid.value
    if (!grid) return
    const renderPage = async (t) => {
      if (t.src || t.error || token !== thumbToken) return
      const page = await doc.getPage(t.page + 1)
      const base = page.getViewport({ scale: 1 })
      if (!base.width) throw new Error('页面宽度为 0')
      const viewport = page.getViewport({ scale: 120 / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')
      // PDF 页面不画白底,透明区域直接编成 JPEG 会变黑,先铺白
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      page.cleanup()
      if (token !== thumbToken) return
      t.src = canvas.toDataURL('image/jpeg', 0.8)
    }
    const queue = (t) => {
      thumbPending += 1
      thumbProgress.value = '正在渲染缩略图…'
      thumbQueue = thumbQueue.then(async () => {
        try {
          await renderPage(t)
        } catch {
          t.error = true
        } finally {
          thumbPending -= 1
          if (thumbPending === 0 && token === thumbToken) thumbProgress.value = ''
        }
      })
    }
    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const t = thumbs.value[Number(entry.target.dataset.page)]
          thumbObserver.unobserve(entry.target)
          if (t) queue(t)
        }
      },
      { rootMargin: '200px' }
    )
    ;[...grid.children].forEach((el, i) => {
      el.dataset.page = String(i)
      thumbObserver.observe(el)
    })
  } catch (e) {
    if (token === thumbToken) thumbError.value = `缩略图生成失败:${e.message}`
  }
}

onUnmounted(cleanupThumbs)

function togglePage(page, ev) {
  const set = new Set(selectedSet.value)
  if (ev.shiftKey && anchor.value != null) {
    const from = Math.min(anchor.value, page)
    const to = Math.max(anchor.value, page)
    for (let p = from; p <= to; p += 1) set.add(p)
  } else {
    if (set.has(page)) set.delete(page)
    else set.add(page)
    anchor.value = page
  }
  range.value = formatPageRange([...set])
}

const selectAll = () => {
  range.value = formatPageRange(Array.from({ length: pageCount.value }, (_, i) => i))
}

const clearSelection = () => {
  range.value = ''
  anchor.value = null
}

// 释放所选 PDF 与已生成的缩略图(keep-alive 下切换标签不会自动释放)
function clearAll() {
  cleanupThumbs()
  files.value = []
  thumbs.value = []
  range.value = ''
  anchor.value = null
  reorderMode.value = false
  reorderPicks.value = []
  thumbError.value = ''
  progress.value = ''
}

function onThumbClick(t, ev) {
  if (reorderMode.value) toggleReorderPage(t.page)
  else togglePage(t.page, ev)
}

function startReorder() {
  if (!files.value.length) {
    alert('请先选择 PDF 文件。')
    return
  }
  reorderMode.value = true
  reorderPicks.value = []
  range.value = ''
  anchor.value = null
}

function cancelReorder() {
  reorderMode.value = false
  reorderPicks.value = []
}

function toggleReorderPage(page) {
  const i = reorderPicks.value.indexOf(page)
  if (i >= 0) reorderPicks.value.splice(i, 1)
  else reorderPicks.value.push(page)
}

function reorderBadge(page) {
  const i = reorderPicks.value.indexOf(page)
  return i >= 0 ? i + 1 : 0
}

const saveReorder = () => run(async () => {
  const file = current()
  if (!file) return
  if (!reorderPicks.value.length) {
    alert('请先按目标顺序点击页面。')
    return
  }
  const order = [...reorderPicks.value]
  for (let i = 0; i < file.pageCount; i += 1) if (!order.includes(i)) order.push(i)
  const src = await PDFDocument.load(file.data)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, order)
  copied.forEach((p) => out.addPage(p))
  await save(await out.save(), `${file.stem}_重排.pdf`)
  reorderMode.value = false
  reorderPicks.value = []
})

function current() {
  if (!files.value.length) {
    alert('请先选择 PDF 文件。')
    return null
  }
  return files.value[0]
}

function requireRange(file) {
  if (!range.value.trim()) {
    alert('请先在缩略图选择页面,或输入页码范围,例如 1-3,5')
    return null
  }
  const pages = parsePageRange(range.value, file.pageCount)
  if (!pages) {
    alert(`页码范围无效:「${range.value}」\n要求 1 到 ${file.pageCount} 的页码,支持 1-3,5 这样的写法,不能倒序。`)
    return null
  }
  return pages
}

async function save(bytes, defaultName) {
  const target = await window.api.saveFile({ defaultName, filters: PDF_FILTERS })
  if (!target) return
  await window.api.writeFile(target, bytes)
  alert(`已保存:${target}`)
}

async function run(fn) {
  if (busy.value) return
  busy.value = true
  try {
    await fn()
  } catch (e) {
    alert(`处理失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

const merge = () => run(async () => {
  if (files.value.length < 2) {
    alert('合并至少需要选择两个 PDF 文件。')
    return
  }
  const out = await PDFDocument.create()
  for (const f of files.value) {
    const src = await PDFDocument.load(f.data)
    const copied = await out.copyPages(src, src.getPageIndices())
    copied.forEach((p) => out.addPage(p))
  }
  await save(await out.save(), '合并结果.pdf')
})

const extract = () => run(async () => {
  const file = current()
  if (!file) return
  const pages = requireRange(file)
  if (!pages) return
  const out = await PDFDocument.create()
  const src = await PDFDocument.load(file.data)
  const copied = await out.copyPages(src, pages)
  copied.forEach((p) => out.addPage(p))
  await save(await out.save(), `${file.stem}_提取.pdf`)
})

const split = () => run(async () => {
  const file = current()
  if (!file) return
  let segments
  if (splitMode.value === 'every') {
    const n = Math.floor(Number(everyN.value))
    if (!Number.isFinite(n) || n < 1) {
      alert('每 N 页必须是 ≥1 的整数。')
      return
    }
    segments = []
    for (let start = 0; start < file.pageCount; start += n) {
      segments.push(
        Array.from({ length: Math.min(n, file.pageCount - start) }, (_, i) => start + i)
      )
    }
  } else {
    const pages = requireRange(file)
    if (!pages) return
    segments = splitPageSegments(pages)
  }
  const dir = await window.api.pickDirectory()
  if (!dir) return
  const src = await PDFDocument.load(file.data)
  const errors = []
  let written = 0
  for (let k = 0; k < segments.length; k += 1) {
    const seg = segments[k]
    progress.value = `正在拆分 ${k + 1}/${segments.length}`
    const name = `${file.stem}_p${seg[0] + 1}-${seg[seg.length - 1] + 1}.pdf`
    try {
      const out = await PDFDocument.create()
      const copied = await out.copyPages(src, seg)
      copied.forEach((p) => out.addPage(p))
      await window.api.writeUnique(dir, name, await out.save())
      written += 1
    } catch (e) {
      errors.push({ name, message: e.message })
    }
  }
  if (errors.length) {
    alert(`已导出 ${written} 个,失败 ${errors.length} 个:\n${errors.slice(0, 5).map((e) => `${e.name}:${e.message}`).join('\n')}`)
  } else {
    alert(`已导出 ${written} 个文件到 ${dir}`)
  }
})

function rotate(delta) {
  return () => run(async () => {
    const file = current()
    if (!file) return
    const pages = requireRange(file)
    if (!pages) return
    const doc = await PDFDocument.load(file.data)
    for (const i of pages) {
      const page = doc.getPage(i)
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360))
    }
    await save(await doc.save(), `${file.stem}_旋转.pdf`)
  })
}

const removePages = () => run(async () => {
  const file = current()
  if (!file) return
  const pages = requireRange(file)
  if (!pages) return
  if (pages.length === file.pageCount) {
    alert('不能删除所有页面。')
    return
  }
  const doc = await PDFDocument.load(file.data)
  for (const i of [...pages].sort((a, b) => b - a)) doc.removePage(i)
  await save(await doc.save(), `${file.stem}_删除.pdf`)
})

const extractText = () => run(async () => {
  const file = current()
  if (!file) return
  let pages
  if (range.value.trim()) {
    pages = requireRange(file)
    if (!pages) return
  } else {
    pages = Array.from({ length: file.pageCount }, (_, i) => i)
  }
  const target = await window.api.saveFile({
    defaultName: `${file.stem}_文本.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  })
  if (!target) return
  // pdfjs 会把 buffer 转移给 worker,必须传副本,否则缓存的 data 被释放
  const doc = await pdfjsLib.getDocument({ data: file.data.slice(0) }).promise
  const chunks = []
  try {
    for (let k = 0; k < pages.length; k += 1) {
      progress.value = `正在提取文本 ${k + 1}/${pages.length}`
      const page = await doc.getPage(pages[k] + 1)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      chunks.push(text.trimEnd())
      page.cleanup()
    }
  } finally {
    doc.destroy().catch(() => {})
  }
  const body = chunks.join('\n\n').trimEnd()
  if (!body) {
    alert('未提取到文本:该 PDF 可能是扫描件。')
    return
  }
  await window.api.writeFile(target, await window.api.encodeText(body + '\n', 'utf8bom'))
  alert(`已保存文本:${target}`)
})

const exportPng = () => run(async () => {
  const file = current()
  if (!file) return
  let pages
  if (range.value.trim()) {
    pages = requireRange(file)
    if (!pages) return
  } else {
    pages = Array.from({ length: file.pageCount }, (_, i) => i)
  }
  const dir = await window.api.pickDirectory()
  if (!dir) return
  const dpi = Math.min(600, Math.max(72, Number(pngDpi.value) || 150))
  const scale = dpi / 72
  const jpg = pngFormat.value === 'jpg'
  const quality = Math.min(100, Math.max(1, Number(pngQuality.value) || 85)) / 100
  // pdfjs 会把 buffer 转移给 worker,必须传副本,否则缓存的 data 被释放
  const doc = await pdfjsLib.getDocument({ data: file.data.slice(0) }).promise
  const errors = []
  let written = 0
  try {
    for (let k = 0; k < pages.length; k += 1) {
      const i = pages[k]
      progress.value = `正在导出 ${k + 1}/${pages.length}`
      const name = `${file.stem}_p${i + 1}.${jpg ? 'jpg' : 'png'}`
      try {
        const page = await doc.getPage(i + 1)
        const viewport = page.getViewport({ scale })
        const pixels = viewport.width * viewport.height
        // 32 位进程 + 无硬件加速:先算像素再开画布,超限的页明确报错跳过而不是静默降 DPI
        if (pixels > MAX_EXPORT_PIXELS) {
          throw new Error(`页面约 ${(pixels / 1e6).toFixed(1)} 百万像素,超出内存上限已跳过;请降低导出 DPI`)
        }
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.ceil(viewport.width))
        canvas.height = Math.max(1, Math.ceil(viewport.height))
        const ctx = canvas.getContext('2d')
        if (jpg) {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        await page.render({ canvasContext: ctx, viewport }).promise
        const blob = await new Promise((resolve) =>
          canvas.toBlob(resolve, jpg ? 'image/jpeg' : 'image/png', jpg ? quality : undefined)
        )
        if (!blob) throw new Error('编码失败')
        await window.api.writeUnique(dir, name, await blob.arrayBuffer())
        written += 1
        page.cleanup()
      } catch (e) {
        errors.push({ name, message: e.message })
      }
    }
  } finally {
    doc.destroy().catch(() => {})
  }
  if (errors.length) {
    alert(`已导出 ${written} 张,失败 ${errors.length} 张:\n${errors.slice(0, 5).map((e) => `${e.name}:${e.message}`).join('\n')}`)
  } else {
    alert(`已导出 ${written} 张图片到 ${dir}`)
  }
})

// /Filter 可能是单个 /Name,也可能是 [/FlateDecode /DCTDecode] 数组
function readFilters(dict) {
  const filter = dict.get(PDFName.of('Filter'))
  if (filter instanceof PDFArray) return filter.asArray().map((f) => f.toString().replace(/^\//, ''))
  return filter ? [filter.toString().replace(/^\//, '')] : []
}

// SMask 是不透明通道时才可以安全丢弃(PNG 生成的 PDF 几乎都带 SMask)。
// 真有透明像素则跳过,避免把背景烧成黑色。alpha 扫描在主进程完成,渲染层不接收 RGBA。
async function isOpaqueSmask(doc, smask) {
  try {
    const target = smask instanceof PDFRef ? doc.context.lookup(smask) : smask
    if (!(target instanceof PDFRawStream)) return false
    const dict = target.dict
    const width = num(dict, 'Width')
    const height = num(dict, 'Height')
    if (!width || !height) return false
    const bits = num(dict, 'BitsPerComponent')
    if (bits != null && bits !== 8) return false
    return await window.api.isOpaque(target.asUint8Array(), {
      filters: readFilters(dict),
      colorSpace: '/DeviceGray',
      width,
      height
    })
  } catch {
    return false
  }
}

// 压缩:对内嵌位图降采样(目标 DPI)并统一重编码 JPEG。CMYK / 真透明 / 非 8 位深跳过保真。
const compress = () => run(async () => {
  const file = current()
  if (!file) return
  const target = Math.min(600, Math.max(36, Number(targetDpi.value) || 150))
  const doc = await PDFDocument.load(file.data)
  let replaced = 0
  let skipped = 0

  // 被别的图像当作 SMask 引用的是 alpha 通道,不是独立图像,不参与压缩
  const smaskRefs = new Set()
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const smask = obj.dict.get(PDFName.of('SMask'))
    if (smask instanceof PDFRef) smaskRefs.add(smask.toString())
  }

  const objects = doc.context.enumerateIndirectObjects()
  for (let idx = 0; idx < objects.length; idx += 1) {
    const [ref, obj] = objects[idx]
    if (idx % 50 === 0) progress.value = `正在压缩 ${idx + 1}/${objects.length}`
    if (!(obj instanceof PDFRawStream)) continue
    if (smaskRefs.has(ref.toString())) continue
    if (obj.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue

    const dict = obj.dict
    const width = num(dict, 'Width')
    const height = num(dict, 'Height')
    if (!width || !height) {
      skipped += 1
      continue
    }
    const colorSpace = dict.get(PDFName.of('ColorSpace'))?.toString() || ''
    if (!isCompressibleImage({
      width,
      height,
      colorSpace,
      bits: num(dict, 'BitsPerComponent'),
      hasDecodeParms: Boolean(dict.get(PDFName.of('DecodeParms'))),
      hasDecode: Boolean(dict.get(PDFName.of('Decode'))),
      hasMask: Boolean(dict.get(PDFName.of('Mask'))),
      imageMask: dict.get(PDFName.of('ImageMask'))?.toString() === 'true'
    })) {
      skipped += 1
      continue
    }

    let dropSmask = false
    const smask = dict.get(PDFName.of('SMask'))
    if (smask) {
      dropSmask = await isOpaqueSmask(doc, smask)
      if (!dropSmask) {
        skipped += 1
        continue
      }
    }

    const dpi = estimateDpi(doc, ref, width)
    let maxWidth = width
    if (dpi != null && dpi > target) {
      maxWidth = Math.max(1, Math.round(width * Math.max(0.05, target / dpi)))
    }
    let jpeg
    try {
      jpeg = await window.api.embeddedJpeg(obj.asUint8Array(), {
        filters: readFilters(dict),
        colorSpace,
        width,
        height,
        maxWidth,
        quality: 75
      })
    } catch {
      skipped += 1
      continue
    }
    dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'))
    dict.set(PDFName.of('Width'), PDFNumber.of(jpeg.width))
    dict.set(PDFName.of('Height'), PDFNumber.of(jpeg.height))
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'))
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8))
    if (dict.get(PDFName.of('DecodeParms'))) dict.delete(PDFName.of('DecodeParms'))
    if (dropSmask) {
      dict.delete(PDFName.of('SMask'))
      // 丢掉引用后这个 alpha 流已无人引用,不删掉会白占体积
      if (smask instanceof PDFRef) doc.context.delete(smask)
    }
    obj.contents = new Uint8Array(jpeg.data)
    replaced += 1
  }

  if (replaced === 0 && skipped === 0) {
    alert('该 PDF 未检测到可压缩的图片。')
    return
  }
  await save(await doc.save({ useObjectStreams: true }), `${file.stem}_压缩.pdf`)
  alert(`压缩完成:重写 ${replaced} 张图片,跳过 ${skipped} 张。`)
})
</script>

<template>
  <div class="tool" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" :disabled="busy" @click="pick">选择 PDF</button>
      <input v-model="range" type="text" style="width: 220px" placeholder="页码范围,如 1-3,5(可点缩略图)" />
      <button class="act" @click="clearAll">清空</button>
      <span class="hint">范围为空时「导出 PNG」「提取文本」处理全部页面;其他操作必须填写范围(对第一个文件生效)</span>
    </div>

    <ul v-if="files.length" class="filelist">
      <li v-for="(f, i) in files" :key="f.path">
        {{ i === 0 ? '★ ' : '' }}{{ f.name }} — {{ f.pageCount }} 页
      </li>
    </ul>

    <div v-if="pageCount" class="thumbbox">
      <div class="row">
        <span v-if="!reorderMode" class="hint">缩略图针对第一个文件:单击选中/取消,Shift+单击连选;不选页时「导出 PNG」处理全部页面</span>
        <span v-else class="hint">重排:按目标顺序依次点击页面,未点选的页保持原顺序排在末尾</span>
        <template v-if="!reorderMode">
          <button class="act" @click="selectAll">全选</button>
          <button class="act" @click="clearSelection">清空</button>
          <button class="act" @click="startReorder">重排页面</button>
        </template>
        <template v-else>
          <button class="act" :disabled="busy" @click="saveReorder">保存重排</button>
          <button class="act" @click="cancelReorder">取消重排</button>
        </template>
        <span class="hint">{{ thumbProgress }}</span>
        <span v-if="thumbError" class="hint warn">{{ thumbError }}</span>
      </div>
      <div ref="thumbGrid" class="thumbgrid">
        <div
          v-for="t in thumbs"
          :key="t.page"
          class="thumb"
          :class="{ on: reorderMode ? reorderBadge(t.page) > 0 : selectedSet.has(t.page) }"
          @click="onThumbClick(t, $event)"
        >
          <img v-if="t.src" :src="t.src" :alt="`第 ${t.page + 1} 页`" />
          <div v-else class="thumb-ph">{{ t.error ? '渲染失败' : '…' }}</div>
          <span v-if="reorderMode && reorderBadge(t.page)" class="thumb-pick">{{ reorderBadge(t.page) }}</span>
          <span class="thumb-no">{{ t.page + 1 }}</span>
        </div>
      </div>
    </div>

    <div class="row">
      <label>导出 DPI
        <input v-model="pngDpi" type="number" min="72" max="600" step="1" style="width: 80px" />
      </label>
      <label>格式
        <select v-model="pngFormat">
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
        </select>
      </label>
      <label v-if="pngFormat === 'jpg'">质量
        <input v-model="pngQuality" type="number" min="1" max="100" style="width: 65px" />
      </label>
      <span class="hint">150 DPI ≈ 2 倍;JPG 会自动铺白底;单页超过 3000 万像素(约 139MB)会跳过并提示,降低 DPI 再导</span>
    </div>

    <div class="row">
      <button class="act" :disabled="busy" @click="merge">合并(按选择顺序)</button>
      <label>拆分方式
        <select v-model="splitMode">
          <option value="segments">按范围连续段</option>
          <option value="every">每 N 页(全文)</option>
        </select>
      </label>
      <input v-if="splitMode === 'every'" v-model="everyN" type="number" min="1" style="width: 70px" />
      <button class="act" :disabled="busy" @click="split">拆分</button>
      <button class="act" :disabled="busy" @click="extract">提取为新 PDF</button>
      <button class="act" :disabled="busy" @click="rotate(-90)">左旋 90°</button>
      <button class="act" :disabled="busy" @click="rotate(90)">右旋 90°</button>
      <button class="act" :disabled="busy" @click="rotate(180)">旋转 180°</button>
      <button class="act" :disabled="busy" @click="removePages">删除范围页</button>
      <button class="act" :disabled="busy" @click="exportPng">导出 {{ pngFormat === 'jpg' ? 'JPG' : 'PNG' }}</button>
      <button class="act" :disabled="busy" @click="extractText">提取文本(TXT)</button>
      <span class="hint">{{ progress }}</span>
    </div>

    <div class="row">
      <label>压缩目标 DPI
        <input v-model="targetDpi" type="number" min="36" max="600" style="width: 80px" />
      </label>
      <label>档位
        <select v-model.number="targetDpi">
          <option :value="72">普通(72 DPI)</option>
          <option :value="150">均衡(150 DPI)</option>
          <option :value="300">高质量(300 DPI)</option>
        </select>
      </label>
      <button class="act" :disabled="busy" @click="compress">压缩图片</button>
      <span class="hint">只处理内嵌位图(扫描件/图多的 PDF 效果明显),文字型 PDF 几乎不会变小</span>
    </div>
  </div>
</template>
