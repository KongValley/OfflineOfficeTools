import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { CATEGORIES, convert, formatNumber } = await loadEsm('../src/renderer/src/utils/units.js')

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`)

test('长度/重量/面积换算', () => {
  assert.equal(convert(1, 'length', 'km', 'm'), 1000)
  near(convert(1, 'length', 'in', 'cm'), 2.54)
  near(convert(1, 'length', 'chi', 'cm'), 100 / 3)
  assert.equal(convert(1, 'weight', 'jin', 'g'), 500)
  near(convert(1, 'weight', 'lb', 'g'), 453.59237)
  near(convert(1, 'area', 'mu', 'm2'), 666.6666666666666)
  near(convert(1, 'area', 'ha', 'mu'), 15)
})

test('温度换算', () => {
  assert.equal(convert(0, 'temperature', 'c', 'f'), 32)
  assert.equal(convert(100, 'temperature', 'c', 'f'), 212)
  near(convert(0, 'temperature', 'c', 'k'), 273.15)
  near(convert(-40, 'temperature', 'f', 'c'), -40)
  near(convert(32, 'temperature', 'f', 'k'), 273.15)
})

test('存储按 1024 换算', () => {
  assert.equal(convert(1, 'data', 'mb', 'kb'), 1024)
  assert.equal(convert(1, 'data', 'gb', 'b'), 1024 ** 3)
  assert.equal(convert(8, 'data', 'bit', 'b'), 1)
})

test('无效输入返回 null', () => {
  assert.equal(convert('abc', 'length', 'm', 'km'), null)
  assert.equal(convert(1, 'nope', 'm', 'km'), null)
  assert.equal(convert(1, 'length', 'm', 'nope'), null)
  assert.equal(CATEGORIES.length, 6)
})

test('formatNumber 去掉浮点尾差', () => {
  assert.equal(formatNumber(0.1 + 0.2), '0.3')
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber(Infinity), '—')
  assert.ok(formatNumber(1e-12).includes('e'))
})
