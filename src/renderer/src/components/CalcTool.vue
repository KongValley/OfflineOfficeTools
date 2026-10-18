<script setup>
import { computed, onMounted, ref } from 'vue'
import { amountToChinese } from '../utils/finance.js'
import { addDays, addWorkdays, daysBetween, formatDate, parseDate, wholeMonthsBetween, workdaysBetween } from '../utils/dates.js'

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

// --- 金额大写 ---
const amountInput = ref('')
const amountResult = computed(() => {
  if (!amountInput.value.trim()) return '—'
  const r = amountToChinese(amountInput.value)
  return r === null ? '无法识别:请输入数字(如 1234.56)' : r
})
const AMOUNT_SAMPLES = ['100', '1000', '10000', '100000', '1000000', '1234.56']

// --- 日期间隔 ---
const dateA = ref('')
const dateB = ref('')
const intervalOut = ref('')

function calcInterval() {
  const a = parseDate(dateA.value)
  const b = parseDate(dateB.value)
  if (!a || !b) {
    intervalOut.value = '请输入两个有效日期(YYYY-MM-DD)'
    return
  }
  const lo = a <= b ? a : b
  const hi = a <= b ? b : a
  const days = daysBetween(lo, hi)
  const months = wholeMonthsBetween(lo, hi)
  const years = hi.getFullYear() - lo.getFullYear()
  const workdays = Math.max(0, workdaysBetween(lo, hi) - 1)
  intervalOut.value = `${formatDate(lo)} ~ ${formatDate(hi)}:共 ${days} 天 = ${(days / 7).toFixed(1)} 周 ≈ ${Math.floor(days / 30)} 个月;` +
    `折合 ${months} 个整月 ${years} 年;工作日 ${workdays} 天`
}

// --- 工作日推算 ---
const wdStart = ref('')
const wdCount = ref(1)
const wdOut = ref('')

function calcWorkdays() {
  const start = parseDate(wdStart.value)
  const n = Math.floor(Number(wdCount.value))
  if (!start) {
    wdOut.value = '请输入有效起始日期(YYYY-MM-DD)'
    return
  }
  if (!Number.isFinite(n) || n < 1 || n > 2000) {
    wdOut.value = '工作日数需在 1–2000 之间'
    return
  }
  const { date, weekends } = addWorkdays(start, n)
  wdOut.value = `自 ${formatDate(start)} 起第 ${n} 个工作日是 ${formatDate(date)}(星期${WEEKDAY[date.getDay()]}),期间跨过周末 ${weekends} 天`
}

// --- 日期相加 ---
const addBase = ref('')
const addOffset = ref(30)
const addOut = ref('')

function calcAddDays() {
  const base = parseDate(addBase.value)
  const n = Math.floor(Number(addOffset.value))
  if (!base) {
    addOut.value = '请输入有效基准日期(YYYY-MM-DD)'
    return
  }
  if (!Number.isFinite(n) || Math.abs(n) > 36500) {
    addOut.value = '天数需在 ±36500 之间'
    return
  }
  const r = addDays(base, n)
  addOut.value = `${formatDate(base)} ${n >= 0 ? '+' : '-'} ${Math.abs(n)} 天 = ${formatDate(r)}(星期${WEEKDAY[r.getDay()]})`
}

// --- 待办 ---
const todos = ref([])
const todoInput = ref('')
const hideDone = ref(false)

const visibleTodos = computed(() => (hideDone.value ? todos.value.filter((t) => !t.done) : todos.value))
const doneCount = computed(() => todos.value.filter((t) => t.done).length)

async function persist() {
  const ok = await window.api.saveTodos(todos.value.map(({ id, text, done }) => ({ id, text, done })))
  if (!ok) alert('待办保存失败')
}

onMounted(async () => {
  const list = await window.api.loadTodos()
  if (Array.isArray(list)) {
    todos.value = list
      .filter((t) => t && typeof t.text === 'string')
      .map((t) => ({ id: String(t.id || Math.random()), text: t.text, done: Boolean(t.done) }))
  }
})

function addTodo() {
  const text = todoInput.value.trim()
  if (!text) return
  todos.value.push({ id: `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text, done: false })
  todoInput.value = ''
  persist()
}

function toggleTodo(t) {
  t.done = !t.done
  persist()
}

function removeTodo(id) {
  todos.value = todos.value.filter((t) => t.id !== id)
  persist()
}

function clearDone() {
  todos.value = todos.value.filter((t) => !t.done)
  persist()
}
</script>

<template>
  <div class="tool cards">
    <div class="card">
      <div class="card-title">金额大写</div>
      <div class="row">
        <input id="amount-input" v-model="amountInput" type="text" style="width: 220px" placeholder="输入金额,如 1234.56" />
        <button v-for="s in AMOUNT_SAMPLES" :key="s" class="act" @click="amountInput = s">{{ s }}</button>
      </div>
      <div class="calc-out">{{ amountResult }}</div>
      <div class="hint">支持小数第三位四舍五入;可带 ¥/￥/元/千分位逗号,负数加「负」</div>
    </div>

    <div class="card">
      <div class="card-title">日期间隔</div>
      <div class="row">
        <input id="date-a" v-model="dateA" type="text" style="width: 130px" placeholder="YYYY-MM-DD" />
        <span>→</span>
        <input id="date-b" v-model="dateB" type="text" style="width: 130px" placeholder="YYYY-MM-DD" />
        <button class="act" @click="calcInterval">计算</button>
      </div>
      <div class="calc-out">{{ intervalOut }}</div>
      <div class="hint">自动按早晚排序;工作日不含首日、只算周一至周五(不含法定节假日)</div>
    </div>

    <div class="card">
      <div class="card-title">工作日推算</div>
      <div class="row">
        <input id="wd-start" v-model="wdStart" type="text" style="width: 152px" placeholder="起始日 YYYY-MM-DD" />
        <label>工作日数
          <input id="wd-count" v-model="wdCount" type="number" min="1" max="2000" style="width: 80px" />
        </label>
        <button class="act" @click="calcWorkdays">计算</button>
      </div>
      <div class="calc-out">{{ wdOut }}</div>
      <div class="hint">从起始日的次日起数,只算周一至周五</div>
    </div>

    <div class="card">
      <div class="card-title">日期相加</div>
      <div class="row">
        <input id="add-base" v-model="addBase" type="text" style="width: 152px" placeholder="基准日 YYYY-MM-DD" />
        <label>天数(可负)
          <input id="add-offset" v-model="addOffset" type="number" step="1" style="width: 80px" />
        </label>
        <button class="act" @click="calcAddDays">计算</button>
      </div>
      <div class="calc-out">{{ addOut }}</div>
      <div class="hint">结果同时给出星期几</div>
    </div>

    <div class="card wide">
      <div class="card-title">待办</div>
      <div class="row">
        <input
          id="todo-input"
          v-model="todoInput"
          type="text"
          style="width: 260px"
          placeholder="输入待办内容,回车添加"
          @keyup.enter="addTodo"
        />
        <button class="act" @click="addTodo">添加</button>
        <label><input v-model="hideDone" type="checkbox" /> 隐藏已完成</label>
        <button class="act" :disabled="!doneCount" @click="clearDone">清除已完成</button>
        <span class="hint">共 {{ todos.length }} 项,完成 {{ doneCount }} 项</span>
      </div>
      <div v-if="!visibleTodos.length" class="hint">{{ todos.length ? '全部已完成(勾掉「隐藏已完成」可查看)' : '暂无待办' }}</div>
      <div v-for="t in visibleTodos" :key="t.id" class="todo-item" :class="{ done: t.done }">
        <input type="checkbox" :checked="t.done" @change="toggleTodo(t)" />
        <span class="tt">{{ t.text }}</span>
        <button class="act" @click="removeTodo(t.id)">删除</button>
      </div>
    </div>
  </div>
</template>
