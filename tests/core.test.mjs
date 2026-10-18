import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const iconv = require('iconv-lite')
const { detectEncoding, decodeText, encodeText } = require('../src/main/encoding.js')

// 渲染层工具是无 import 的纯 ESM,统一用 data URL 载入,绕开 package.json 未声明 type: module
function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { parsePageRange, formatPageRange, splitPageSegments } = await loadEsm('../src/renderer/src/utils/pageRange.js')
const { dedupeLines, sortLineList, trimLineList } = await loadEsm('../src/renderer/src/utils/textLines.js')
const { isCompressibleImage } = await loadEsm('../src/renderer/src/utils/pdfImage.js')
const { resolveLocalPath } = await loadEsm('../src/renderer/src/utils/markdownImages.js')

test('parsePageRange 解析与拒绝非法输入', () => {
  assert.deepEqual(parsePageRange('1-3,5', 10), [0, 1, 2, 4])
  assert.deepEqual(parsePageRange('2', 2), [1])
  assert.equal(parsePageRange('3-1', 10), null)
  assert.equal(parsePageRange('0', 10), null)
  assert.equal(parsePageRange('1-3,5', 4), null)
  assert.equal(parsePageRange('', 10), null)
})

test('formatPageRange 压缩连续段并可往返', () => {
  assert.equal(formatPageRange([0, 1, 2, 4]), '1-3,5')
  assert.equal(formatPageRange([]), '')
  assert.equal(formatPageRange([3, 1, 2, 1]), '2-4')
  assert.deepEqual(parsePageRange(formatPageRange([0, 1, 2, 4]), 10), [0, 1, 2, 4])
})

test('splitPageSegments 切连续段', () => {
  assert.deepEqual(splitPageSegments([0, 1, 2, 4, 5]), [[0, 1, 2], [4, 5]])
  assert.deepEqual(splitPageSegments([]), [])
})

test('行处理保留换行风格与末尾换行', () => {
  assert.equal(dedupeLines('a\nb\na\n'), 'a\nb\n')
  assert.equal(dedupeLines('a\nb\na'), 'a\nb')
  assert.equal(dedupeLines(''), '')
  assert.equal(sortLineList('b\r\na\r\n'), 'a\r\nb\r\n')
  assert.equal(trimLineList(' a \n\n b \n'), 'a\nb\n')
})

test('isCompressibleImage 白名单', () => {
  const base = { width: 10, height: 10, colorSpace: '/DeviceRGB', bits: 8 }
  assert.equal(isCompressibleImage(base), true)
  assert.equal(isCompressibleImage({ ...base, colorSpace: '/DeviceGray', bits: 1, hasDecodeParms: false, hasDecode: false, hasMask: false, imageMask: false }), false)
  assert.equal(isCompressibleImage({ ...base, colorSpace: '[/Indexed /DeviceRGB 1]' }), false)
  assert.equal(isCompressibleImage({ ...base, hasDecodeParms: true }), false)
  assert.equal(isCompressibleImage({ ...base, hasDecode: true }), false)
  assert.equal(isCompressibleImage({ ...base, hasMask: true }), false)
  assert.equal(isCompressibleImage({ ...base, imageMask: true }), false)
  assert.equal(isCompressibleImage({ ...base, width: 0 }), false)
})

test('resolveLocalPath 只解析相对图片路径', () => {
  assert.equal(resolveLocalPath('F:\\doc', 'pic.png'), 'F:\\doc\\pic.png')
  assert.equal(resolveLocalPath('F:\\doc', '../up.png'), 'F:\\up.png')
  assert.equal(resolveLocalPath('F:\\doc', './img/a%20b.png'), 'F:\\doc\\img\\a b.png')
  assert.equal(resolveLocalPath('F:\\doc', 'https://x/a.png'), null)
  assert.equal(resolveLocalPath('F:\\doc', 'data:image/png;base64,x'), null)
  assert.equal(resolveLocalPath('F:\\doc', '/abs.png'), null)
  assert.equal(resolveLocalPath('', 'pic.png'), null)
})

test('编码检测、解码与编码', () => {
  assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf8bom')
  assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'utf16le')
  assert.equal(detectEncoding(Buffer.from([0xfe, 0xff, 0x4e, 0x2d])), 'utf16be')
  assert.equal(detectEncoding(Buffer.from('hello')), 'utf8')
  assert.equal(detectEncoding(iconv.encode('中文', 'gb18030')), 'gb18030')
  assert.equal(decodeText(iconv.encode('中文', 'gbk'), 'auto').text, '中文')
  assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x4e, 0x2d]), 'auto').text, '中')
  assert.equal(decodeText(Buffer.from('\uFEFFhi'), 'utf8bom').text, 'hi')
  assert.equal(iconv.decode(encodeText('中文', 'gb18030'), 'gb18030'), '中文')
})
