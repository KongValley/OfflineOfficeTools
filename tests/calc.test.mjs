import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 渲染层工具是无 import 的纯 ESM,统一用 data URL 载入,绕开 package.json 未声明 type: module
function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { amountToChinese } = await loadEsm('../src/renderer/src/utils/finance.js')
const { addDays, addWorkdays, daysBetween, formatDate, parseDate, wholeMonthsBetween, workdaysBetween } =
  await loadEsm('../src/renderer/src/utils/dates.js')

test('金额大写', () => {
  assert.equal(amountToChinese('1234.56'), '壹仟贰佰叁拾肆元伍角陆分')
  assert.equal(amountToChinese('0.05'), '零元零伍分')
  assert.equal(amountToChinese('10001'), '壹万零壹元整')
  assert.equal(amountToChinese('200020002'), '贰亿零贰万零贰元整')
  assert.equal(amountToChinese('1005000'), '壹佰万零伍仟元整')
  assert.equal(amountToChinese('1.999'), '贰元整')
  assert.equal(amountToChinese('-1.5'), '负壹元伍角')
  assert.equal(amountToChinese('abc'), null)
  assert.equal(amountToChinese(''), null)
  assert.equal(amountToChinese('0'), '零元整')
  // 千分位、货币符号与「元」后缀都容忍
  assert.equal(amountToChinese('￥1,234.5元'), '壹仟贰佰叁拾肆元伍角')
  // 超过 2^53 也走 BigInt,不按 Number 舍入成 …0992
  assert.ok(amountToChinese('9007199254740993').endsWith('玖佰玖拾叁元整'))
  assert.ok(amountToChinese(String(Number('9007199254740993'))).endsWith('玖佰玖拾贰元整'))
})

test('日期解析与格式化', () => {
  assert.equal(parseDate('2024-02-30'), null)
  assert.equal(parseDate('2024-2-29') && formatDate(parseDate('2024-2-29')), '2024-02-29')
  assert.equal(parseDate('2023-02-29'), null)
  assert.equal(parseDate('2024/01/01'), null)
  assert.equal(formatDate(addDays(parseDate('2024-02-28'), 1)), '2024-02-29')
  assert.equal(formatDate(addDays(parseDate('2024-01-01'), -1)), '2023-12-31')
})

test('日期间隔与工作日', () => {
  assert.equal(daysBetween(parseDate('2024-01-01'), parseDate('2024-03-01')), 60)
  assert.equal(daysBetween(parseDate('2024-03-01'), parseDate('2024-01-01')), -60)
  assert.equal(wholeMonthsBetween(parseDate('2024-01-01'), parseDate('2024-03-01')), 2)
  assert.equal(wholeMonthsBetween(parseDate('2024-01-31'), parseDate('2024-03-01')), 1)
  assert.equal(workdaysBetween(parseDate('2024-03-01'), parseDate('2024-03-03')), 1)
  const next = addWorkdays(parseDate('2024-03-01'), 1)
  assert.equal(formatDate(next.date), '2024-03-04')
  assert.equal(next.weekends, 2)
  const ten = addWorkdays(parseDate('2024-03-01'), 10)
  assert.equal(formatDate(ten.date), '2024-03-15')
})
