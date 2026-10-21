<script setup>
import { ref } from 'vue'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import {
  addPageNumbers,
  addWatermark,
  clearMetadata,
  cropPages,
  insertBlankPages,
  insertPdfPages,
  readMetadata,
  readOutlines,
  setMetadata,
  setOutlines,
  stampImage
} from '../utils/pdfOps.js'
import { imposeNup, unifyPageSize } from '../utils/pdfCompose.js'
import { parsePageRange } from '../utils/pageRange.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const PDF_FILTERS = [{ name: 'PDF 文件', extensions: ['pdf'] }]
const IMAGE_FILTERS = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]
const file = ref(null)
const busy = ref(false)
const progress = ref('')

// 文档信息
const metaTitle = ref('')
const metaAuthor = ref('')
const metaSubject = ref('')
const metaKeywords = ref('')

// 插入页面
const insertAt = ref('')
const blankCount = ref(1)
const blankSize = ref('a4')
const insertSrc = ref(null)
const insertRange = ref('')

// 图片盖章
const stampImg = ref(null)
const stampPos = ref('bottom-right')
const stampWidth = ref(30)
const stampOpacity = ref(1)
const stampAngle = ref(0)
const stampMargin = ref(24)
const stampRange = ref('')

// 拼版 / 页面尺寸
const composeMode = ref('nup')
const nupCount = ref(2)
const nupPaper = ref('a4')
const nupOrientation = ref('auto')
const nupMargin = ref(18)
const nupGap = ref(6)
const nupOrder = ref('row')
const nupRange = ref('')
const fitPaper = ref('a4')
const fitOrientation = ref('auto')
const fitMargin = ref(12)
const fitRange = ref('')

// 加页码
const numberPos = ref('bottom-center')
const numberFormat = ref('第{n}页')
const numberColor = ref('gray')
const numberStart = ref(1)
// 裁剪
const cropMargin = ref(10)
// 书签
const headingSize = ref(14)
const outlineText = ref('')
// 水印
const watermarkText = ref('内部资料')
const watermarkOpacity = ref(0.15)
const watermarkAngle = ref(45)
const watermarkColor = ref('gray')
const watermarkTile = ref(true)

const baseName = (p) => p.split(/[\\/]/).pop()

// 中文字体只在第一次用时向主进程要一次,之后的文档共用字节
let cjkBytes = null
async function embedCjk(doc) {
  if (!cjkBytes) cjkBytes = await window.api.loadCjkFont()
  doc.registerFontkit(fontkit)
  return doc.embedFont(cjkBytes, { subset: true })
}

async function loadPath(p) {
  try {
    const size = await window.api.fileSize(p)
    if (size > 200 * 1024 * 1024 &&
        !confirm(`「${baseName(p)}」约 ${(size / 1048576).toFixed(0)} MB,内存有限,处理可能较慢,继续?`)) {
      return
    }
    const data = await window.api.readFile(p)
    const doc = await PDFDocument.load(data)
    const name = baseName(p)
    file.value = { path: p, name, stem: name.replace(/\.pdf$/i, ''), pageCount: doc.getPageCount(), data }
    outlineText.value = ''
    const meta = readMetadata(doc)
    metaTitle.value = meta.title
    metaAuthor.value = meta.author
    metaSubject.value = meta.subject
    metaKeywords.value = meta.keywords.split(/[,，;；\s]+/).filter(Boolean).join(', ')
    insertSrc.value = null
    insertRange.value = ''
    stampImg.value = null
    stampRange.value = ''
    nupRange.value = ''
    fitRange.value = ''
  } catch (e) {
    alert(`无法读取「${baseName(p)}」:${e.message}\n该 PDF 可能已加密或已损坏。`)
  }
}

async function pick() {
  const paths = await window.api.openFiles({ filters: PDF_FILTERS, multiple: false })
  if (paths.length) await loadPath(paths[0])
}

function onDrop(e) {
  if (busy.value) return
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter((p) => /\.pdf$/i.test(p || ''))
  if (!paths.length) {
    alert('请拖入 PDF 文件。')
    return
  }
  if (paths.length > 1) alert(`本页一次处理一个文件,已选用:${baseName(paths[0])}`)
  loadPath(paths[0])
}

function clearAll() {
  file.value = null
  outlineText.value = ''
  progress.value = ''
  metaTitle.value = ''
  metaAuthor.value = ''
  metaSubject.value = ''
  metaKeywords.value = ''
  insertSrc.value = null
  insertRange.value = ''
  stampImg.value = null
  stampRange.value = ''
  nupRange.value = ''
  fitRange.value = ''
}

// fn 返回后缀则保存为「原名+后缀.pdf」,返回 null 表示不需要保存
async function run(label, fn) {
  if (busy.value) return
  const f = file.value
  if (!f) {
    alert('请先选择 PDF 文件。')
    return
  }
  busy.value = true
  try {
    const doc = await PDFDocument.load(f.data)
    const suffix = await fn(doc, f)
    if (!suffix) return
    const target = await window.api.saveFile({ defaultName: `${f.stem}${suffix}.pdf`, filters: PDF_FILTERS })
    if (!target) return
    await window.api.writeFile(target, await doc.save())
    alert(`已保存:${target}`)
  } catch (e) {
    alert(`${label}失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

// 拼版/统一尺寸会生成一份新文档,和上面的原地修改分开存
async function runCompose(label, suffix, fn) {
  if (busy.value) return
  const f = file.value
  if (!f) {
    alert('请先选择 PDF 文件。')
    return
  }
  busy.value = true
  try {
    const src = await PDFDocument.load(f.data)
    const out = await fn(src)
    const target = await window.api.saveFile({ defaultName: `${f.stem}${suffix}.pdf`, filters: PDF_FILTERS })
    if (!target) return
    await window.api.writeFile(target, await out.save())
    alert(`已保存:${target}`)
  } catch (e) {
    alert(`${label}失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

const saveMetadata = () => run('保存元数据', async (doc) => {
  setMetadata(doc, {
    title: metaTitle.value,
    author: metaAuthor.value,
    subject: metaSubject.value,
    keywords: metaKeywords.value
  })
  return '_元数据'
})

function parseInsertAt(f) {
  const raw = String(insertAt.value).trim()
  const n = raw === '' ? f.pageCount : Math.trunc(Number(raw))
  if (!Number.isInteger(n) || n < 0 || n > f.pageCount) {
    alert(`插入位置需在 0–${f.pageCount} 之间(0=最前,留空=末尾)`)
    return null
  }
  return n
}

// 「同前一页」:插到 at 时取 at-1 的尺寸;插到最前时取第 1 页
function blankDims(doc, at) {
  if (blankSize.value !== 'prev' || !doc.getPageCount()) return [595.28, 841.89]
  const index = at > 0 ? Math.min(at - 1, doc.getPageCount() - 1) : 0
  const box = doc.getPage(index).getCropBox()
  return [box.width, box.height]
}

async function pickInsertSource() {
  const paths = await window.api.openFiles({ filters: PDF_FILTERS, multiple: false })
  if (!paths.length) return
  try {
    const data = await window.api.readFile(paths[0])
    const doc = await PDFDocument.load(data)
    const name = baseName(paths[0])
    insertSrc.value = {
      path: paths[0],
      name,
      stem: name.replace(/\.pdf$/i, ''),
      pageCount: doc.getPageCount(),
      data
    }
    insertRange.value = ''
  } catch (e) {
    alert(`无法读取「${baseName(paths[0])}」:${e.message}`)
  }
}

const insertBlank = () => run('插入空白页', async (doc, f) => {
  const at = parseInsertAt(f)
  if (at == null) return null
  const count = Math.trunc(Number(blankCount.value))
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    alert('空白页数需在 1–1000 之间')
    return null
  }
  insertBlankPages(doc, at, count, blankDims(doc, at))
  return '_插入'
})

const insertFromPdf = () => run('插入 PDF 页面', async (doc, f) => {
  if (!insertSrc.value) {
    alert('请先选择要插入的 PDF。')
    return null
  }
  const at = parseInsertAt(f)
  if (at == null) return null
  const srcDoc = await PDFDocument.load(insertSrc.value.data)
  let pages
  if (insertRange.value.trim()) {
    pages = parsePageRange(insertRange.value, insertSrc.value.pageCount)
    if (!pages) {
      alert(`源页码范围无效,要求 1 到 ${insertSrc.value.pageCount},支持 1-3,5 写法。`)
      return null
    }
  } else {
    pages = srcDoc.getPageIndices()
  }
  await insertPdfPages(doc, srcDoc, at, pages)
  return '_插入'
})

function imageKind(data) {
  const b = new Uint8Array(data)
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  return null
}

async function pickStampImage() {
  const paths = await window.api.openFiles({ filters: IMAGE_FILTERS, multiple: false })
  if (!paths.length) return
  try {
    const data = await window.api.readFile(paths[0])
    const kind = imageKind(data)
    if (!kind) {
      alert('请选择 PNG 或 JPG 图片。')
      return
    }
    stampImg.value = { path: paths[0], name: baseName(paths[0]), kind, data }
  } catch (e) {
    alert(`无法读取「${baseName(paths[0])}」:${e.message}`)
  }
}

const stampSeal = () => run('图片盖章', async (doc, f) => {
  if (!stampImg.value) {
    alert('请先选择公章/签名图片。')
    return null
  }
  let pages
  if (stampRange.value.trim()) {
    pages = parsePageRange(stampRange.value, f.pageCount)
    if (!pages) {
      alert(`页码范围无效,要求 1 到 ${f.pageCount},支持 1-3,5 写法。`)
      return null
    }
  }
  const img = stampImg.value.kind === 'png'
    ? await doc.embedPng(stampImg.value.data)
    : await doc.embedJpg(stampImg.value.data)
  stampImage(doc, img, {
    pages,
    pos: stampPos.value,
    widthPercent: Number(stampWidth.value),
    opacity: Number(stampOpacity.value),
    angle: Number(stampAngle.value),
    margin: Number(stampMargin.value)
  })
  return '_盖章'
})

// 留空返回 undefined(全部);非法返回 null 并提示
function rangePages(raw, f) {
  const text = String(raw).trim()
  if (!text || !f) return undefined
  const pages = parsePageRange(text, f.pageCount)
  if (!pages) alert(`页码范围无效,要求 1 到 ${f.pageCount},支持 1-3,5 写法。`)
  return pages
}

const doNup = () => {
  const pages = rangePages(nupRange.value, file.value)
  if (pages === null) return
  return runCompose('拼版', '_拼版', (src) => imposeNup(src, {
    n: Number(nupCount.value),
    pageSize: nupPaper.value,
    orientation: nupOrientation.value,
    margin: Number(nupMargin.value),
    gap: Number(nupGap.value),
    order: nupOrder.value,
    pages
  }))
}

const doFit = () => {
  const pages = rangePages(fitRange.value, file.value)
  if (pages === null) return
  return runCompose('统一页面尺寸', '_统一尺寸', (src) => unifyPageSize(src, {
    pageSize: fitPaper.value,
    orientation: fitOrientation.value,
    margin: Number(fitMargin.value),
    pages
  }))
}

const addNumbering = () => run('添加页码', async (doc) => {
  const font = await embedCjk(doc)
  addPageNumbers(doc, {
    start: Math.max(1, Math.floor(Number(numberStart.value) || 1)),
    pos: numberPos.value,
    format: numberFormat.value,
    color: numberColor.value
  }, font)
  return '_页码'
})

const stripMetadata = () => run('清除元数据', async (doc) => {
  clearMetadata(doc)
  return '_去元数据'
})

const crop = () => run('裁剪边距', async (doc) => {
  cropPages(doc, Number(cropMargin.value))
  return '_裁剪'
})

// 逐页取文本,按字号阈值挑标题;pdfjs 会转移 buffer,必须传副本
async function detectHeadings(data, threshold) {
  const jsDoc = await pdfjsLib.getDocument({ data: data.slice(0) }).promise
  const items = []
  try {
    for (let p = 1; p <= jsDoc.numPages; p += 1) {
      progress.value = `正在识别标题 ${p}/${jsDoc.numPages}`
      const page = await jsDoc.getPage(p)
      const content = await page.getTextContent()
      for (const item of content.items) {
        const text = typeof item.str === 'string' ? item.str.trim() : ''
        if (text && item.height >= threshold) items.push({ level: 1, title: text, page: p })
      }
      page.cleanup()
    }
  } finally {
    jsDoc.destroy().catch(() => {})
  }
  if (!items.length) alert('未检测到标题(可调小字号阈值)')
  return items
}

const autoOutline = () => run('自动生成书签', async (doc, f) => {
  const threshold = Math.min(48, Math.max(6, Number(headingSize.value) || 14))
  const items = await detectHeadings(f.data, threshold)
  if (!items.length) return null
  setOutlines(doc, items)
  return '_书签'
})

const readCurrentOutline = () => run('读取书签', async (doc) => {
  const list = readOutlines(doc)
  outlineText.value = list.map(([level, title, page]) => `${level}|${title}|${page}`).join('\n')
  if (!list.length) alert('该 PDF 没有书签,可在下方按格式手写后再保存。')
  return null
})

function parseOutlineText(text) {
  const items = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split('|')
    const level = parts.length >= 3 ? parts[0].trim() : ''
    const page = parts.length >= 3 ? parts[parts.length - 1].trim() : ''
    if (!/^\d+$/.test(level) || !/^\d+$/.test(page) || !parts.slice(1, -1).join('|').trim()) {
      alert('书签格式应为 层级|标题|页码(如 1|第一章|1)')
      return null
    }
    items.push({ level: Number(level), page: Number(page), title: parts.slice(1, -1).join('|').trim() })
  }
  if (!items.length) {
    alert('书签内容为空,每行按 层级|标题|页码 填写。')
    return null
  }
  return items
}

const saveOutlineText = () => run('保存书签', async (doc) => {
  const items = parseOutlineText(outlineText.value)
  if (!items) return null
  setOutlines(doc, items)
  return '_书签'
})

const stampWatermark = () => run('添加水印', async (doc) => {
  const font = await embedCjk(doc)
  addWatermark(doc, {
    text: watermarkText.value,
    opacity: Math.min(0.5, Math.max(0.05, Number(watermarkOpacity.value) || 0.15)),
    angle: Number(watermarkAngle.value) || 0,
    color: watermarkColor.value,
    tile: watermarkTile.value
  }, font)
  return '_水印'
})
</script>

<template>
  <div class="tool" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" :disabled="busy" @click="pick">选择 PDF</button>
      <button class="act" @click="clearAll">清空</button>
      <span class="hint">单文件操作,结果另存为新文件,原文件不动;页码/水印用系统黑体之类的中文字体子集嵌入</span>
      <span class="hint">{{ progress }}</span>
    </div>

    <ul v-if="file" class="filelist">
      <li>{{ file.name }} — {{ file.pageCount }} 页</li>
    </ul>

    <div class="cards">
      <div class="card">
        <div class="card-title">加页码</div>
        <div class="row">
          <label>位置
            <select v-model="numberPos">
              <option value="bottom-center">底部居中</option>
              <option value="bottom-right">底部右侧</option>
              <option value="bottom-left">底部左侧</option>
              <option value="top-center">顶部居中</option>
            </select>
          </label>
          <label>格式
            <select v-model="numberFormat">
              <option value="第{n}页">第{n}页</option>
              <option value="{n}">{n}</option>
              <option value="第{n}页/共{total}页">第{n}页/共{total}页</option>
              <option value="-{n}-">-{n}-</option>
            </select>
          </label>
          <label>颜色
            <select v-model="numberColor">
              <option value="gray">灰</option>
              <option value="black">黑</option>
              <option value="red">红</option>
              <option value="blue">蓝</option>
            </select>
          </label>
          <label>起始页号
            <input v-model="numberStart" type="number" min="1" style="width: 70px" />
          </label>
          <button class="act" :disabled="busy" @click="addNumbering">添加页码并保存</button>
        </div>
        <div class="hint">全部页面,9pt,距边缘 24pt</div>
      </div>

      <div class="card">
        <div class="card-title">页面整理</div>
        <div class="row">
          <label>裁剪边距 pt
            <input v-model="cropMargin" type="number" min="0" max="200" style="width: 75px" />
          </label>
          <button class="act" :disabled="busy" @click="crop">四周裁剪并保存</button>
        </div>
        <div class="hint">裁剪只改 CropBox,页面内容不重排</div>
      </div>

      <div class="card wide">
        <div class="card-title">文档信息</div>
        <div class="row">
          <label>标题
            <input v-model="metaTitle" type="text" style="width: 200px" placeholder="文档标题" />
          </label>
          <label>作者
            <input v-model="metaAuthor" type="text" style="width: 140px" placeholder="作者" />
          </label>
          <label>主题
            <input v-model="metaSubject" type="text" style="width: 160px" placeholder="主题" />
          </label>
          <label>关键词
            <input v-model="metaKeywords" type="text" style="width: 180px" placeholder="合同,2026,重要" />
          </label>
        </div>
        <div class="row">
          <button class="act" :disabled="busy" @click="saveMetadata">保存元数据</button>
          <button class="act" :disabled="busy" @click="stripMetadata">清除元数据</button>
          <span class="hint">关键词用逗号或分号分隔;只写 PDF Info 字典,部分阅读器优先显示的 XMP 不会同步</span>
        </div>
      </div>

      <div class="card wide">
        <div class="card-title">插入页面</div>
        <div class="row">
          <label>插入位置
            <input v-model="insertAt" type="number" min="0" style="width: 90px" placeholder="留空=末尾" />
          </label>
          <span class="hint">在第 N 页后插入,0=最前</span>
          <label>空白页数
            <input v-model="blankCount" type="number" min="1" max="1000" style="width: 75px" />
          </label>
          <label>尺寸
            <select v-model="blankSize">
              <option value="a4">A4</option>
              <option value="prev">同前一页</option>
            </select>
          </label>
          <button class="act" :disabled="busy" @click="insertBlank">插入空白页</button>
        </div>
        <div class="row">
          <button class="act" :disabled="busy" @click="pickInsertSource">选择要插入的 PDF</button>
          <span v-if="insertSrc" class="hint">{{ insertSrc.name }} — {{ insertSrc.pageCount }} 页</span>
          <input v-model="insertRange" type="text" style="width: 190px" placeholder="源页码范围,留空=全部" />
          <button class="act" :disabled="busy || !insertSrc" @click="insertFromPdf">插入所选页</button>
        </div>
        <div class="hint">只插入页面内容,源文档的书签不会带过来</div>
      </div>

      <div class="card wide">
        <div class="card-title">图片盖章 / 签名</div>
        <div class="row">
          <button class="act" :disabled="busy" @click="pickStampImage">选择图片</button>
          <span v-if="stampImg" class="hint">{{ stampImg.name }} ({{ stampImg.kind.toUpperCase() }})</span>
          <label>位置
            <select v-model="stampPos">
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
          <label>宽度 %
            <input v-model="stampWidth" type="number" min="1" max="100" style="width: 70px" />
          </label>
          <label>透明度
            <input v-model.number="stampOpacity" type="range" min="0.05" max="1" step="0.05" />
            {{ Math.round(stampOpacity * 100) }}%
          </label>
          <label>角度(逆时针)
            <select v-model.number="stampAngle">
              <option :value="0">0°</option>
              <option :value="30">30°</option>
              <option :value="45">45°</option>
              <option :value="90">90°</option>
              <option :value="-45">-45°</option>
            </select>
          </label>
          <label>边距 pt
            <input v-model="stampMargin" type="number" min="0" max="200" style="width: 70px" />
          </label>
          <label>页码范围
            <input v-model="stampRange" type="text" style="width: 150px" placeholder="留空=全部" />
          </label>
          <button class="act" :disabled="busy" @click="stampSeal">盖章并保存</button>
        </div>
        <div class="hint">公章/签名建议用透明背景 PNG;JPG 会带白色背景;宽度按页面宽度百分比缩放;带旋转的页面按可见方向摆放并自动抵消 /Rotate</div>
      </div>

      <div class="card wide">
        <div class="card-title">拼版 / 页面尺寸</div>
        <div class="row">
          <label>模式
            <select v-model="composeMode">
              <option value="nup">拼版(多页合一)</option>
              <option value="fit">统一页面尺寸</option>
            </select>
          </label>
          <template v-if="composeMode === 'nup'">
            <label>每张页数
              <select v-model.number="nupCount">
                <option :value="2">2 页</option>
                <option :value="4">4 页</option>
                <option :value="6">6 页</option>
                <option :value="9">9 页</option>
              </select>
            </label>
            <label>纸张
              <select v-model="nupPaper">
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
            </label>
            <label>方向
              <select v-model="nupOrientation">
                <option value="auto">自动</option>
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
            </label>
            <label>留白 pt
              <input v-model="nupMargin" type="number" min="0" max="72" style="width: 70px" />
            </label>
            <label>间距 pt
              <input v-model="nupGap" type="number" min="0" max="36" style="width: 70px" />
            </label>
            <label>顺序
              <select v-model="nupOrder">
                <option value="row">先行后列</option>
                <option value="column">先列后行</option>
              </select>
            </label>
            <label>页码范围
              <input v-model="nupRange" type="text" style="width: 130px" placeholder="留空=全部" />
            </label>
            <button class="act" :disabled="busy" @click="doNup">生成拼版 PDF</button>
          </template>
          <template v-else>
            <label>纸张
              <select v-model="fitPaper">
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
            </label>
            <label>方向
              <select v-model="fitOrientation">
                <option value="auto">自动(按每页)</option>
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
            </label>
            <label>留白 pt
              <input v-model="fitMargin" type="number" min="0" max="72" style="width: 70px" />
            </label>
            <label>页码范围
              <input v-model="fitRange" type="text" style="width: 130px" placeholder="留空=全部" />
            </label>
            <button class="act" :disabled="busy" @click="doFit">统一尺寸并保存</button>
          </template>
        </div>
        <div class="hint">保留矢量内容;会丢失书签、链接、批注与表单字段;自动方向:2 合 1 用横向,其余纵向;填写页码范围时只输出所选页</div>
      </div>

      <div class="card wide">
        <div class="card-title">目录书签</div>
        <div class="row">
          <label>标题字号阈值
            <input v-model="headingSize" type="number" min="6" max="48" style="width: 70px" />
          </label>
          <button class="act" :disabled="busy" @click="autoOutline">自动生成书签</button>
          <button class="act" :disabled="busy" @click="readCurrentOutline">读取当前书签</button>
          <button class="act" :disabled="busy" @click="saveOutlineText">按文本保存书签</button>
        </div>
        <textarea
          v-model="outlineText"
          rows="6"
          style="width: 100%"
          placeholder="每行一条:层级|标题|页码,如&#10;1|第一章 概述|1&#10;2|1.1 背景|2"
        />
        <div class="hint" style="margin-top: 8px">自动识别按字号挑标题(文字型 PDF),层级统一为 1 级,可在这里改成 1-6 级再保存</div>
      </div>

      <div class="card wide">
        <div class="card-title">文字水印</div>
        <div class="row">
          <label>文字
            <input v-model="watermarkText" type="text" style="width: 180px" placeholder="内部资料" />
          </label>
          <label>透明度
            <input v-model.number="watermarkOpacity" type="range" min="0.05" max="0.5" step="0.05" />
            {{ Math.round(watermarkOpacity * 100) }}%
          </label>
          <label>角度
            <select v-model.number="watermarkAngle">
              <option :value="0">0°</option>
              <option :value="30">30°</option>
              <option :value="45">45°</option>
              <option :value="60">60°</option>
            </select>
          </label>
          <label>颜色
            <select v-model="watermarkColor">
              <option value="gray">灰</option>
              <option value="red">红</option>
              <option value="blue">蓝</option>
            </select>
          </label>
          <label><input v-model="watermarkTile" type="checkbox" /> 平铺</label>
          <button class="act" :disabled="busy" @click="stampWatermark">添加水印并保存</button>
        </div>
        <div class="hint">不勾平铺则整页居中一个;水印是真实文字,可选中/可搜索</div>
      </div>
    </div>
  </div>
</template>
