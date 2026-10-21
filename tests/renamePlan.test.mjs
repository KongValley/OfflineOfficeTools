import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { splitExt, validateName, buildRenamePlan } = await loadEsm('../src/renderer/src/utils/renamePlan.js')

const files = (names, dir = 'C:\\docs') =>
  names.map((name) => ({ path: `${dir}\\${name}`, name }))

test('splitExt 处理多点与无扩展名', () => {
  assert.deepEqual(splitExt('a.tar.gz'), { stem: 'a.tar', ext: 'gz' })
  assert.deepEqual(splitExt('README'), { stem: 'README', ext: '' })
  assert.deepEqual(splitExt('.gitignore'), { stem: '.gitignore', ext: '' })
})

test('validateName 拒绝 Windows 非法名', () => {
  assert.equal(validateName('正常.txt'), null)
  assert.match(validateName('a:b.txt'), /不允许/)
  assert.match(validateName('CON.txt'), /保留名/)
  assert.match(validateName('a.'), /空格或点/)
  assert.match(validateName('a '), /空格或点/)
  assert.match(validateName(''), /为空/)
})

test('前后缀、替换、序号、扩展名按顺序叠加', () => {
  const plan = buildRenamePlan(files(['报告.doc', '附件.doc']), {
    find: '报告',
    replace: '总结',
    prefix: '2026_',
    suffix: '_终稿',
    newExt: 'pdf',
    sequence: { enabled: true, start: 1, step: 1, digits: 2, position: 'end', separator: '-' }
  })
  assert.deepEqual(plan.map((p) => p.to), ['2026_总结_终稿-01.pdf', '2026_附件_终稿-02.pdf'])
  assert.ok(plan.every((p) => p.valid))
})

test('序号放开头与标题大小写', () => {
  const plan = buildRenamePlan(files(['hello.txt', 'world.txt']), {
    prefix: 'p-',
    caseMode: 'title',
    sequence: { enabled: true, start: 9, step: 2, digits: 3, position: 'start', separator: '_' }
  })
  assert.deepEqual(plan.map((p) => p.to), ['009_p-Hello.txt', '011_p-World.txt'])
})

test('同目录重名与非法名在预览中标红', () => {
  const dup = buildRenamePlan(files(['a.txt', 'a.md']), { newExt: 'txt' })
  assert.equal(dup.filter((p) => !p.valid).length, 2)
  assert.match(dup[0].error, /重名/)

  const bad = buildRenamePlan(files(['a:b.txt']), { prefix: 'x' })
  assert.equal(bad[0].valid, false)
  assert.match(bad[0].error, /不允许/)
})

test('不同目录可以有同名目标', () => {
  const plan = buildRenamePlan([
    { path: 'C:\\a\\x.txt', name: 'x.txt' },
    { path: 'D:\\b\\x.txt', name: 'x.txt' }
  ], { prefix: 'n_' })
  assert.ok(plan.every((p) => p.valid))
  assert.deepEqual(plan.map((p) => p.to), ['n_x.txt', 'n_x.txt'])
})

test('序号参数非法时抛错', () => {
  assert.throws(() => buildRenamePlan(files(['a.txt']), { sequence: { enabled: true, step: 0 } }), /步长/)
  assert.throws(() => buildRenamePlan(files(['a.txt']), { sequence: { enabled: true, digits: 20 } }), /位数/)
})
