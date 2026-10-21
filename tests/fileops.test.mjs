import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs, { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const {
  validateName,
  applyRenamePlan,
  undoPairs,
  saveUndo,
  loadUndo,
  clearUndo,
  hashFile
} = require('../src/main/fileOps.js')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'oot-fileops-'))
}

test('validateName 与渲染层规则一致', () => {
  assert.equal(validateName('ok.txt'), null)
  assert.match(validateName('CON.txt'), /保留名/)
  assert.match(validateName('a/b.txt'), /不允许/)
  assert.match(validateName('a.'), /空格或点/)
})

test('两阶段重命名支持互换', () => {
  const dir = tempDir()
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    const applied = applyRenamePlan([{ from: a, to: b }, { from: b, to: a }])
    assert.equal(applied.length, 2)
    assert.equal(readFileSync(a, 'utf8'), 'B')
    assert.equal(readFileSync(b, 'utf8'), 'A')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('普通重命名、仅大小写改名与同目录限制', () => {
  const dir = tempDir()
  try {
    const src = join(dir, 'old.txt')
    const dst = join(dir, 'new.txt')
    writeFileSync(src, 'x')
    applyRenamePlan([{ from: src, to: dst }])
    assert.equal(existsSync(src), false)
    assert.equal(readFileSync(dst, 'utf8'), 'x')

    const upper = join(dir, 'NEW.TXT')
    assert.doesNotThrow(() => applyRenamePlan([{ from: dst, to: upper }]))
    assert.equal(readFileSync(upper, 'utf8'), 'x')

    assert.throws(
      () => applyRenamePlan([{ from: upper, to: join(dir, 'sub', 'x.txt') }]),
      /同目录/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('冲突与非法目标被拒绝且源文件不变', () => {
  const dir = tempDir()
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    assert.throws(() => applyRenamePlan([{ from: a, to: b }]), /已存在/)
    assert.equal(readFileSync(a, 'utf8'), 'A')

    assert.throws(
      () => applyRenamePlan([{ from: a, to: join(dir, 'CON.txt') }]),
      /保留名/
    )
    assert.equal(readFileSync(a, 'utf8'), 'A')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('撤销记录保存/读取/清除', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'undo.json')
    const pairs = [{ from: join(dir, 'a'), to: join(dir, 'b') }]
    saveUndo(file, pairs)
    assert.deepEqual(loadUndo(file), pairs)
    assert.deepEqual(undoPairs(pairs), [{ from: join(dir, 'b'), to: join(dir, 'a') }])
    clearUndo(file)
    assert.equal(loadUndo(file), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hashFile 一次算出三个哈希', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'abc.txt')
    writeFileSync(file, 'abc')
    const result = await hashFile(file)
    assert.equal(result.size, 3)
    assert.equal(result.md5, createHash('md5').update('abc').digest('hex'))
    assert.equal(result.sha1, createHash('sha1').update('abc').digest('hex'))
    assert.equal(result.sha256, createHash('sha256').update('abc').digest('hex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('批量重命名完成后目录里没有临时文件残留', () => {
  const dir = tempDir()
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'A')
    writeFileSync(b, 'B')
    applyRenamePlan([{ from: a, to: join(dir, 'a2.txt') }, { from: b, to: join(dir, 'b2.txt') }])
    assert.deepEqual(readdirSync(dir).sort(), ['a2.txt', 'b2.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function withRenameFailure(failAt, fn) {
  const original = fs.renameSync
  let calls = 0
  fs.renameSync = (...args) => {
    calls += 1
    if (calls === failAt) throw new Error('inject')
    return original.apply(fs, args)
  }
  try {
    fn()
  } finally {
    fs.renameSync = original
  }
}

test('暂存阶段失败时全部回滚', () => {
  const dir = tempDir()
  try {
    const files = ['a.txt', 'b.txt', 'c.txt']
    for (const name of files) writeFileSync(join(dir, name), name)
    const pairs = files.map((name, i) => ({ from: join(dir, name), to: join(dir, `x${i}.txt`) }))
    // 第 2 次 rename 失败:第 1 个文件已改成临时名
    withRenameFailure(2, () => {
      assert.throws(() => applyRenamePlan(pairs), /已回滚.*inject/)
    })
    assert.deepEqual(readdirSync(dir).sort(), files)
    for (const name of files) assert.equal(readFileSync(join(dir, name), 'utf8'), name)
    assert.ok(!readdirSync(dir).some((n) => n.startsWith('.oot-ren-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目标阶段失败时已落位文件也回滚', () => {
  const dir = tempDir()
  try {
    const files = ['a.txt', 'b.txt', 'c.txt']
    for (const name of files) writeFileSync(join(dir, name), name)
    const pairs = files.map((name, i) => ({ from: join(dir, name), to: join(dir, `y${i}.txt`) }))
    // 3 次暂存成功后,第 5 次(第 2 个目标)失败
    withRenameFailure(5, () => {
      assert.throws(() => applyRenamePlan(pairs), /已回滚.*inject/)
    })
    assert.deepEqual(readdirSync(dir).sort(), files)
    for (const name of files) assert.equal(readFileSync(join(dir, name), 'utf8'), name)
    assert.ok(!readdirSync(dir).some((n) => n.startsWith('.oot-ren-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
