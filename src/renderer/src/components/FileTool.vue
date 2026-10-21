<script setup>
import { computed, ref } from 'vue'
import { buildRenamePlan } from '../utils/renamePlan.js'

const files = ref([]) // { path, name }
const busy = ref(false)
const progress = ref('')

const findText = ref('')
const replaceText = ref('')
const prefix = ref('')
const suffix = ref('')
const useSequence = ref(false)
const seqStart = ref(1)
const seqStep = ref(1)
const seqDigits = ref(2)
const seqPos = ref('end')
const seqSep = ref('-')
const newExt = ref('')
const sortByName = ref(false)

const baseName = (p) => String(p).split(/[\\/]/).pop()

const ordered = computed(() => (sortByName.value
  ? [...files.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  : files.value))

const planResult = computed(() => {
  try {
    return {
      list: buildRenamePlan(ordered.value, {
        find: findText.value,
        replace: replaceText.value,
        prefix: prefix.value,
        suffix: suffix.value,
        newExt: newExt.value,
        sequence: {
          enabled: useSequence.value,
          start: seqStart.value,
          step: seqStep.value,
          digits: seqDigits.value,
          position: seqPos.value,
          separator: seqSep.value
        }
      })
    }
  } catch (e) {
    return { list: [], error: e.message }
  }
})

const plan = computed(() => planResult.value.list)
const changed = computed(() => plan.value.filter((p) => p.valid && p.to !== p.from))
const invalid = computed(() => plan.value.filter((p) => !p.valid))

function addPaths(paths) {
  const seen = new Set(files.value.map((f) => f.path.toLowerCase()))
  for (const p of paths) {
    if (!p) continue
    const key = String(p).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    files.value.push({ path: p, name: baseName(p) })
  }
}

async function pick() {
  const paths = await window.api.openFiles({ multiple: true })
  if (paths.length) addPaths(paths)
}

function onDrop(e) {
  if (busy.value) return
  const paths = [...e.dataTransfer.files].map((f) => f.path).filter(Boolean)
  if (!paths.length) {
    alert('请拖入文件。')
    return
  }
  addPaths(paths)
}

function clearAll() {
  if (busy.value) return
  files.value = []
  progress.value = ''
}

function joinPath(dir, name) {
  if (!dir) return name
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir}${sep}${name}`
}

function applyToFiles(applied) {
  const map = new Map()
  for (const pair of applied) map.set(pair.from.toLowerCase(), pair.to)
  files.value = files.value.map((f) => {
    const next = map.get(f.path.toLowerCase())
    return next ? { path: next, name: baseName(next) } : f
  })
}

async function execute() {
  if (busy.value) return
  if (invalid.value.length) {
    alert('预览里有非法或重名的文件名,请先修正。')
    return
  }
  if (!changed.value.length) {
    alert('没有需要重命名的文件。')
    return
  }
  if (!confirm(`将重命名 ${changed.value.length} 个文件,继续?`)) return
  busy.value = true
  try {
    const applied = await window.api.renameBatch(
      changed.value.map((p) => ({ from: p.path, to: joinPath(p.dir, p.to) }))
    )
    applyToFiles(applied)
    progress.value = `已重命名 ${applied.length} 个文件`
    alert(`已重命名 ${applied.length} 个文件。可在需要时点「撤销上次重命名」。`)
  } catch (e) {
    alert(`重命名失败:${e.message}`)
  } finally {
    busy.value = false
  }
}

async function undo() {
  if (busy.value) return
  if (!confirm('撤销最近一次批量重命名?')) return
  busy.value = true
  try {
    const applied = await window.api.undoRename()
    applyToFiles(applied)
    progress.value = `已撤销 ${applied.length} 个文件`
    alert(`已撤销 ${applied.length} 个文件的重命名。`)
  } catch (e) {
    alert(`撤销失败:${e.message}`)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="tool" @dragover.prevent @drop.prevent="onDrop">
    <div class="row">
      <button class="act primary" :disabled="busy" @click="pick">选择文件</button>
      <button class="act" :disabled="busy || !files.length" @click="clearAll">清空</button>
      <label><input v-model="sortByName" type="checkbox" /> 按文件名排序(影响序号)</label>
      <span class="hint">可拖入任意类型文件;只改文件名,不移动目录,原文件内容不变</span>
      <span class="hint">{{ progress }}</span>
    </div>

    <div class="row">
      <input v-model="findText" type="text" style="width: 160px" placeholder="查找(区分大小写)" />
      <input v-model="replaceText" type="text" style="width: 160px" placeholder="替换为" />
      <input v-model="prefix" type="text" style="width: 120px" placeholder="前缀" />
      <input v-model="suffix" type="text" style="width: 120px" placeholder="后缀" />
      <label>新扩展名
        <input v-model="newExt" type="text" style="width: 80px" placeholder="留空=保持" />
      </label>
    </div>

    <div class="row">
      <label><input v-model="useSequence" type="checkbox" /> 加序号</label>
      <template v-if="useSequence">
        <label>起始
          <input v-model="seqStart" type="number" min="0" max="999999" style="width: 80px" />
        </label>
        <label>步长
          <input v-model="seqStep" type="number" min="1" max="99999" style="width: 70px" />
        </label>
        <label>位数
          <input v-model="seqDigits" type="number" min="1" max="9" style="width: 60px" />
        </label>
        <label>位置
          <select v-model="seqPos">
            <option value="end">文件名后</option>
            <option value="start">文件名前</option>
          </select>
        </label>
        <label>分隔符
          <input v-model="seqSep" type="text" style="width: 60px" />
        </label>
      </template>
      <button class="act" :disabled="busy || !changed.length || invalid.length > 0" @click="execute">
        执行重命名
      </button>
      <button class="act" :disabled="busy" @click="undo">撤销上次重命名</button>
      <span v-if="invalid.length" class="hint warn">有 {{ invalid.length }} 个文件名需要修正</span>
    </div>

    <div v-if="planResult.error" class="hint warn">{{ planResult.error }}</div>
    <div v-else-if="!plan.length" class="hint">还没有选择文件。</div>
    <div v-else class="rename-wrap">
      <table class="rename-table">
        <thead>
          <tr><th>原文件名</th><th>新文件名</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr
            v-for="p in plan"
            :key="p.path"
            :class="{ bad: !p.valid, same: p.valid && p.to === p.from }"
          >
            <td>{{ p.from }}</td>
            <td>{{ p.to }}</td>
            <td>{{ p.valid ? (p.to === p.from ? '不变' : '待重命名') : p.error }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="hint">
      执行时采用两阶段改名,支持 a↔b 互换与仅大小写改名;已存在的同名文件、Windows 保留名、结尾空格或点会被拒绝。
      撤销只保留最近一次,记录在用户数据目录,关闭应用后仍可撤销。
    </div>
  </div>
</template>
