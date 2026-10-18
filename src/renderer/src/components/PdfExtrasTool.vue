<script setup>
import { ref } from 'vue'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'
import { addPageNumbers, addWatermark, clearMetadata, cropPages, readOutlines, setOutlines } from '../utils/pdfOps.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const PDF_FILTERS = [{ name: 'PDF 文件', extensions: ['pdf'] }]
const file = ref(null)
const busy = ref(false)
const progress = ref('')

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
          <button class="act" :disabled="busy" @click="stripMetadata">清除元数据</button>
          <label>裁剪边距 pt
            <input v-model="cropMargin" type="number" min="0" max="200" style="width: 75px" />
          </label>
          <button class="act" :disabled="busy" @click="crop">四周裁剪并保存</button>
        </div>
        <div class="hint">裁剪只改 CropBox,页面内容不重排</div>
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
