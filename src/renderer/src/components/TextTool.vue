<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  addLineNumbers,
  changeCase,
  dedupeLines,
  prefixSuffixLines,
  sortLineList,
  textStats,
  toFullWidth,
  toHalfWidth,
  trimLineList,
  trimLineSides
} from '../utils/textLines.js'

const TEXT_FILTERS = [{ name: '文本文件', extensions: ['txt', 'md', 'log', 'csv', 'json', 'ini', 'xml'] }]
const TEXT_EXT = /\.(txt|md|log|csv|json|ini|xml)$/i
const SOURCES = [
  { label: '自动识别', value: 'auto' },
  { label: 'UTF-8', value: 'utf8' },
  { label: 'GBK', value: 'gbk' },
  { label: 'GB18030', value: 'gb18030' },
  { label: 'UTF-16LE', value: 'utf16le' },
  { label: 'UTF-16BE', value: 'utf16be' }
]
const TARGETS = [
  { label: 'UTF-8', value: 'utf8' },
  { label: 'UTF-8(带 BOM)', value: 'utf8bom' },
  { label: 'GBK', value: 'gbk' },
  { label: 'GB18030', value: 'gb18030' },
  { label: 'UTF-16LE', value: 'utf16le' }
]
const ENCODING_LABELS = {
  utf8: 'UTF-8',
  utf8bom: 'UTF-8 BOM',
  gbk: 'GBK',
  gb18030: 'GB18030',
  utf16le: 'UTF-16LE',
  utf16be: 'UTF-16BE'
}

const files = ref([])
const current = ref(0)
const source = ref('auto')
const target = ref('utf8')
const pattern = ref('')
const replacement = ref('')
const busy = ref(false)
const progress = ref('')

// 行处理与实时统计
const linePrefix = ref('')
const lineSuffix = ref('')
const lineNoStart = ref(1)
const lineNoSep = ref('. ')
const caseMode = ref('upper')
const stats = ref(textStats(''))
let statsTimer = null
const currentText = computed(() => files.value[current.value]?.text || '')
watch(currentText, () => {
  clearTimeout(statsTimer)
  statsTimer = setTimeout(() => {
    stats.value = textStats(currentText.value)
  }, 250)
}, { immediate: true })
onUnmounted(() => clearTimeout(statsTimer))

const splitName = (p) => {
  const name = p.split(/[\\/]/).pop()
  const dot = name.lastIndexOf('.')
  return {
    name: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  }
}

async function loadPaths(paths) {
  const picked = []
  for (const p of paths) {
    try {
      const data = await window.api.readFile(p)
      const { name, ext } = splitName(p)
      if (data.byteLength > 8 * 1024 * 1024 &&
          !confirm(`「${name}.${ext}」约 ${(data.byteLength / 1048576).toFixed(1)} MB,预览可能卡顿,继续?`)) {
        continue
      }
      const { text, encoding } = await window.api.decodeText(data, source.value)
      picked.push({ path: p, name, ext, data, text, encoding })
    } catch (e) {
      alert(`无法读取「${p.split(/[\\/]/).pop()}」:${e.message}`)
    }
  }
  if (picked.length) {
    files.value = picked
    current.value = 0
  }
}

async function pick() {
  const paths = await window.api.openFiles({ filters: TEXT_FILTERS, multiple: true })
  if (!paths.length) return
  await loadPaths(paths)
}

const clearAll = () => {
  files.value = []
  current.value = 0
}

function onDrop(e) {
  if (busy.value) return
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter((p) => TEXT_EXT.test(p || ''))
  if (!paths.length) {
    alert('请拖入文本文件(txt/md/log/csv/json/ini/xml)。')
    return
  }
  loadPaths(paths)
}

async function reload() {
  if (busy.value || !files.value.length) return
  if (!confirm('重新读取会丢弃预览中的修改,继续?')) return
  busy.value = true
  try {
    for (const f of files.value) {
      const { text, encoding } = await window.api.decodeText(f.data, source.value)
      f.text = text
      f.encoding = encoding
    }
  } catch (e) {
    alert(`重新读取失败:${e.message}`)
  } finally {
    busy.value = false
  }
}

function regexReplace(text) {
  if (!pattern.value) {
    alert('请输入正则表达式。')
    return null
  }
  let re
  try {
    re = new RegExp(pattern.value, 'g')
  } catch (e) {
    alert(`正则表达式无效:${e.message}`)
    return null
  }
  return text.replace(re, replacement.value)
}

// 行处理只改当前文件的预览,点上面的保存按钮才写盘
function applyToCurrent(fn, label) {
  if (busy.value) return
  const file = files.value[current.value]
  if (!file) {
    alert('请先选择文本文件。')
    return
  }
  try {
    file.text = fn(file.text)
  } catch (e) {
    alert(`${label}失败:${e.message}`)
  }
}

const applyAffixes = () => applyToCurrent(
  (text) => prefixSuffixLines(text, linePrefix.value, lineSuffix.value),
  '加前后缀'
)
const applyLineNumbers = () => applyToCurrent(
  (text) => addLineNumbers(text, lineNoStart.value, lineNoSep.value),
  '加行号'
)
const applyCase = () => applyToCurrent((text) => changeCase(text, caseMode.value), '转换大小写')
const applyFullWidth = () => applyToCurrent(toFullWidth, '转全角')
const applyHalfWidth = () => applyToCurrent(toHalfWidth, '转半角')
const applyTrimSides = () => applyToCurrent(trimLineSides, '去行首尾空白')

async function saveAll(transform, suffix) {
  if (busy.value) return
  if (!files.value.length) {
    alert('请先选择文本文件。')
    return
  }
  busy.value = true
  try {
    if (files.value.length === 1) {
      const f = files.value[0]
      const next = transform(f.text)
      if (next == null) return
      const savePath = await window.api.saveFile({ defaultName: `${f.name}${suffix}.${f.ext}`, filters: TEXT_FILTERS })
      if (!savePath) return
      await window.api.writeFile(savePath, await window.api.encodeText(next, target.value))
      alert(`已保存:${savePath}`)
      return
    }
    const dir = await window.api.pickDirectory()
    if (!dir) return
    const errors = []
    let written = 0
    for (let idx = 0; idx < files.value.length; idx += 1) {
      const f = files.value[idx]
      progress.value = `正在保存 ${idx + 1}/${files.value.length}`
      const next = transform(f.text)
      if (next == null) return
      try {
        await window.api.writeUnique(dir, `${f.name}${suffix}.${f.ext}`, await window.api.encodeText(next, target.value))
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
    alert(`处理失败:${e.message}`)
  } finally {
    busy.value = false
    progress.value = ''
  }
}

const convert = () => saveAll((t) => t, '_转换')
const applyDedupe = () => saveAll(dedupeLines, '_去重')
const applySort = () => saveAll(sortLineList, '_排序')
const applyTrim = () => saveAll(trimLineList, '_去空行')
const applyRegex = () => saveAll(regexReplace, '_替换')
</script>

<template>
  <div class="tool fill" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" :disabled="busy" @click="pick">选择文本文件</button>
      <button class="act" @click="clearAll">清空</button>
      <label>源编码
        <select v-model="source">
          <option v-for="s in SOURCES" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>
      <button class="act" :disabled="busy" @click="reload">重新读取</button>
      <label>保存为
        <select v-model="target">
          <option v-for="s in TARGETS" :key="s.value" :value="s.value">{{ s.label }}</option>
        </select>
      </label>
      <span class="hint">自动识别按 BOM/严格 UTF-8 判断,其余按 GB18030;切换源编码后点「重新读取」</span>
    </div>

    <div class="row">
      <input v-model="pattern" type="text" style="width: 220px" placeholder="正则模式" />
      <input v-model="replacement" type="text" style="width: 160px" placeholder="替换为" />
      <button class="act" :disabled="busy" @click="applyRegex">正则替换并保存</button>
    </div>

    <div class="row">
      <input v-model="linePrefix" type="text" style="width: 110px" placeholder="行前缀" />
      <input v-model="lineSuffix" type="text" style="width: 110px" placeholder="行后缀" />
      <button class="act" :disabled="busy || !files.length" @click="applyAffixes">加前后缀</button>
      <label>行号从
        <input v-model="lineNoStart" type="number" min="0" style="width: 70px" />
      </label>
      <input v-model="lineNoSep" type="text" style="width: 60px" placeholder=". " />
      <button class="act" :disabled="busy || !files.length" @click="applyLineNumbers">加行号</button>
      <label>大小写
        <select v-model="caseMode">
          <option value="upper">全部大写</option>
          <option value="lower">全部小写</option>
          <option value="title">首字母大写</option>
        </select>
      </label>
      <button class="act" :disabled="busy || !files.length" @click="applyCase">转换</button>
      <button class="act" :disabled="busy || !files.length" @click="applyFullWidth">转全角</button>
      <button class="act" :disabled="busy || !files.length" @click="applyHalfWidth">转半角</button>
      <button class="act" :disabled="busy || !files.length" @click="applyTrimSides">去行首尾空白</button>
    </div>

    <ul v-if="files.length" class="filelist">
      <li
        v-for="(f, i) in files"
        :key="f.path"
        :style="i === current ? 'color:#1f7a4d;font-weight:600' : 'cursor:pointer'"
        @click="current = i"
      >
        {{ f.name }}.{{ f.ext }}
        <span v-if="source === 'auto'" class="hint">— {{ ENCODING_LABELS[f.encoding] || f.encoding }}</span>
      </li>
    </ul>

    <div class="row">
      <button class="act" :disabled="busy" @click="convert">仅转换编码并保存</button>
      <button class="act" :disabled="busy" @click="applyDedupe">去重行(保序)</button>
      <button class="act" :disabled="busy" @click="applySort">行排序(中文)</button>
      <button class="act" :disabled="busy" @click="applyTrim">去空行/首尾空白</button>
      <span class="hint">{{ progress }}</span>
    </div>

    <textarea
      v-if="files.length"
      v-model="files[current].text"
      class="editor"
      rows="14"
      style="width: 100%"
      spellcheck="false"
    ></textarea>
    <div v-if="files.length" class="row" style="margin: 8px 0 0">
      <span class="hint">
        共 {{ stats.chars }} 字(不含空白 {{ stats.charsNoSpace }}),中文 {{ stats.cjk }} 字,
        英文单词 {{ stats.words }},{{ stats.nonEmptyLines }} 行,{{ stats.paragraphs }} 段
      </span>
    </div>
    <div v-if="files.length" class="hint">预览可直接编辑;行处理只改当前文件的预览,点上面任一保存按钮才写盘;输出自动加 _转换/_去重/_排序/_去空行/_替换 后缀</div>
  </div>
</template>
