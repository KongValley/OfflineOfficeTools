<script setup>
import { ref, computed, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { inlineLocalImages } from '../utils/markdownImages.js'

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const MD_FILTERS = [{ name: 'Markdown 文件', extensions: ['md', 'markdown'] }]
const HTML_FILTERS = [{ name: 'HTML 文件', extensions: ['html'] }]
const PDF_FILTERS = [{ name: 'PDF 文件', extensions: ['pdf'] }]

const source = ref('# 标题\n\n这是一段 **粗体** 文字。\n\n- 列表项一\n- 列表项二\n')
const filePath = ref('')
const preview = ref('')
const baseDir = computed(() => (filePath.value ? filePath.value.replace(/[\\/][^\\/]*$/, '') : ''))

let previewTimer = null
let renderToken = 0

watch([source, filePath], () => {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(renderPreview, 150)
}, { immediate: true })

async function renderPreview() {
  const token = ++renderToken
  const inlined = await inlineLocalImages(md.render(source.value), baseDir.value)
  if (token === renderToken) preview.value = inlined
}

async function openPaths(paths) {
  if (!paths.length) return
  try {
    const { text } = await window.api.decodeText(await window.api.readFile(paths[0]), 'auto')
    filePath.value = paths[0]
    source.value = text
  } catch (e) {
    alert(`无法读取文件:${e.message}`)
  }
}

async function open() {
  const paths = await window.api.openFiles({ filters: MD_FILTERS, multiple: false })
  await openPaths(paths)
}

function onDrop(e) {
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter((p) => /\.(md|markdown)$/i.test(p || ''))
  if (!paths.length) {
    alert('请拖入 Markdown 文件(.md/.markdown)。')
    return
  }
  openPaths(paths)
}

const baseName = () =>
  filePath.value ? filePath.value.split(/[\\/]/).pop().replace(/\.md(on)?$/i, '') : '导出'

async function buildHtml() {
  const body = await inlineLocalImages(md.render(source.value), baseDir.value)
  const title = md.render(source.value).match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] || 'Markdown 导出'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
body { max-width: 900px; margin: 40px auto; padding: 0 20px; font-family: "Microsoft YaHei", sans-serif; line-height: 1.7; color: #222; }
h1, h2, h3 { border-bottom: 1px solid #eee; padding-bottom: 6px; }
pre { background: #f0f2f5; padding: 12px; border-radius: 4px; overflow: auto; }
code { background: #f0f2f5; padding: 1px 4px; border-radius: 3px; font-family: Consolas, monospace; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; }
td, th { border: 1px solid #ddd; padding: 5px 10px; }
blockquote { margin: 0; padding-left: 12px; border-left: 4px solid #ddd; color: #666; }
img { max-width: 100%; }
@media print {
  h1, h2, h3 { break-after: avoid; }
  pre, img, table { break-inside: avoid; }
}
</style>
</head>
<body>
${body}
</body>
</html>
`
}

async function saveHtml() {
  const target = await window.api.saveFile({ defaultName: `${baseName()}.html`, filters: HTML_FILTERS })
  if (!target) return
  await window.api.writeFile(target, await window.api.encodeText(await buildHtml(), 'utf8'))
  alert(`已导出:${target}`)
}

async function savePdf() {
  const target = await window.api.saveFile({ defaultName: `${baseName()}.pdf`, filters: PDF_FILTERS })
  if (!target) return
  try {
    await window.api.htmlToPdf(await buildHtml(), target)
    alert(`已导出:${target}`)
  } catch (e) {
    alert(`导出 PDF 失败:${e.message}`)
  }
}
</script>

<template>
  <div class="tool fill" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" @click="open">打开 .md 文件</button>
      <button class="act" @click="saveHtml">导出为 HTML</button>
      <button class="act" @click="savePdf">导出为 PDF</button>
      <span class="hint">左侧编辑,右侧实时预览;相对路径图片会自动内联进预览与导出文件</span>
    </div>
    <div class="md">
      <textarea v-model="source" spellcheck="false" placeholder="在此输入 Markdown"></textarea>
      <div class="preview" v-html="preview"></div>
    </div>
  </div>
</template>
