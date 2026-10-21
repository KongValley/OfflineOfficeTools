<script setup>
import { ref } from 'vue'
import PdfTool from './components/PdfTool.vue'
import PdfExtrasTool from './components/PdfExtrasTool.vue'
import ImageTool from './components/ImageTool.vue'
import TextTool from './components/TextTool.vue'
import MdTool from './components/MdTool.vue'
import FileTool from './components/FileTool.vue'
import CalcTool from './components/CalcTool.vue'

const tools = [
  { id: 'pdf', label: 'PDF 工具', comp: PdfTool },
  { id: 'pdfx', label: 'PDF 整理', comp: PdfExtrasTool },
  { id: 'image', label: '图片工具', comp: ImageTool },
  { id: 'text', label: '文本工具', comp: TextTool },
  { id: 'md', label: 'Markdown', comp: MdTool },
  { id: 'file', label: '文件工具', comp: FileTool },
  { id: 'calc', label: '小工具', comp: CalcTool }
]
const active = ref('pdf')
</script>

<template>
  <div class="app" @dragover.prevent @drop.prevent>
    <header class="tabbar">
      <h1 class="title">离线办公工具</h1>
      <button
        v-for="t in tools"
        :key="t.id"
        class="tab"
        :class="{ on: active === t.id }"
        @click="active = t.id"
      >{{ t.label }}</button>
    </header>
    <main class="panel">
      <keep-alive>
        <component :is="tools.find(t => t.id === active).comp" />
      </keep-alive>
    </main>
  </div>
</template>
