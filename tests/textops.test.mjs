import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const {
  textStats,
  prefixSuffixLines,
  addLineNumbers,
  changeCase,
  toFullWidth,
  toHalfWidth,
  trimLineSides
} = await loadEsm('../src/renderer/src/utils/textLines.js')

test('textStats 统计字数/行数/段落', () => {
  const s = textStats('中文 abc\n\n第二行')
  assert.equal(s.chars, 9)
  assert.equal(s.charsNoSpace, 8)
  assert.equal(s.cjk, 5)
  assert.equal(s.words, 1)
  assert.equal(s.lines, 3)
  assert.equal(s.nonEmptyLines, 2)
  assert.equal(s.paragraphs, 2)
  assert.deepEqual(textStats(''), {
    chars: 0, charsNoSpace: 0, cjk: 0, words: 0, lines: 0, nonEmptyLines: 0, paragraphs: 0
  })
})

test('prefixSuffixLines 只处理非空行并保留换行风格', () => {
  assert.equal(prefixSuffixLines('a\r\n\r\nb\r\n', '> ', ' !'), '> a !\r\n\r\n> b !\r\n')
  assert.equal(prefixSuffixLines('a\nb', '', ''), 'a\nb')
})

test('addLineNumbers 空行不占号', () => {
  assert.equal(addLineNumbers('a\n\nb\n', 1, '. '), '1. a\n\n2. b\n')
  assert.equal(addLineNumbers('a\nb', 10, ') '), '10) a\n11) b')
  assert.equal(addLineNumbers('a', 0, '. '), '0. a')
  assert.throws(() => addLineNumbers('a', -1), /起始行号/)
})

test('changeCase upper/lower/title', () => {
  assert.equal(changeCase('Hello World', 'upper'), 'HELLO WORLD')
  assert.equal(changeCase('Hello World', 'lower'), 'hello world')
  assert.equal(changeCase('hello WORLD\nfoo-bar', 'title'), 'Hello World\nFoo-Bar')
  assert.throws(() => changeCase('x', 'weird'), /未知的大小写模式/)
})

test('全角/半角互转', () => {
  const full = toFullWidth('A B,1')
  assert.equal(full, 'Ａ　Ｂ，１')
  assert.equal(toHalfWidth(full), 'A B,1')
  assert.equal(toHalfWidth('中文ＡＢＣ'), '中文ABC')
})

test('trimLineSides 保留空行', () => {
  assert.equal(trimLineSides(' a \n  \n b '), 'a\n\nb')
})
