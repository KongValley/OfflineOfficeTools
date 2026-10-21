const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/

// 主进程的独立校验:渲染层的预览不可信
function validateName(name) {
  const text = String(name ?? '')
  if (!text) return '文件名为空'
  if (text === '.' || text === '..') return '文件名无效'
  if (INVALID_CHARS.test(text)) return '包含 Windows 不允许的字符'
  if (/[. ]$/.test(text)) return '不能以空格或点结尾'
  if (RESERVED.test(text.split('.')[0])) return '是 Windows 保留名'
  if (text.length > 255) return '文件名过长'
  return null
}

function normalizePairs(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('没有要重命名的文件')
  const list = []
  for (const item of pairs) {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') {
      throw new Error('重命名参数无效')
    }
    if (!path.isAbsolute(item.from) || !path.isAbsolute(item.to)) {
      throw new Error('重命名必须使用绝对路径')
    }
    const from = path.normalize(item.from)
    const to = path.normalize(item.to)
    if (path.dirname(from) !== path.dirname(to)) throw new Error('只支持同目录重命名')
    const nameError = validateName(path.basename(to))
    if (nameError) throw new Error(`「${path.basename(to)}」${nameError}`)
    if (to.length > 250) throw new Error(`目标路径过长:${to}`)
    if (from === to) continue
    list.push({ from, to })
  }
  if (!list.length) throw new Error('文件名没有变化')

  const seenFrom = new Set()
  const seenTo = new Set()
  for (const item of list) {
    const fromKey = item.from.toLowerCase()
    const toKey = item.to.toLowerCase()
    if (seenFrom.has(fromKey)) throw new Error(`源文件重复:${path.basename(item.from)}`)
    seenFrom.add(fromKey)
    if (seenTo.has(toKey)) throw new Error(`同一目录下有多个文件要改成「${path.basename(item.to)}」`)
    seenTo.add(toKey)
  }

  for (const item of list) {
    let stat
    try {
      stat = fs.statSync(item.from)
    } catch {
      throw new Error(`源文件不存在:${path.basename(item.from)}`)
    }
    if (!stat.isFile()) throw new Error(`不是普通文件:${path.basename(item.from)}`)
    if (fs.existsSync(item.to)) {
      const sameFile = item.from.toLowerCase() === item.to.toLowerCase()
      const targetIsSource = list.some((other) => other.from.toLowerCase() === item.to.toLowerCase())
      if (!sameFile && !targetIsSource) {
        throw new Error(`目标文件已存在:${path.basename(item.to)}`)
      }
    }
  }
  return list
}

function tempPath(dir, index) {
  for (let n = 0; n < 1000; n += 1) {
    const candidate = path.join(
      dir,
      `.oot-ren-${process.pid}-${Date.now()}-${index}-${n}.tmp`
    )
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('无法创建临时文件名')
}

// 两阶段:源文件先全部改成临时名,再改成目标名。
// 这样互换(a↔b)与仅大小写改名都不会互相覆盖;任一步失败按相反顺序回滚。
function applyRenamePlan(pairs) {
  const list = normalizePairs(pairs)
  const staged = []
  try {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      const temp = tempPath(path.dirname(item.from), i)
      fs.renameSync(item.from, temp)
      staged.push({ from: item.from, to: item.to, temp })
    }
  } catch (e) {
    for (const item of [...staged].reverse()) {
      try { fs.renameSync(item.temp, item.from) } catch {}
    }
    throw new Error(`重命名失败,已回滚:${e.message}`)
  }

  const done = []
  try {
    for (const item of staged) {
      fs.renameSync(item.temp, item.to)
      done.push(item)
    }
  } catch (e) {
    for (const item of [...done].reverse()) {
      try { fs.renameSync(item.to, item.temp) } catch {}
    }
    for (const item of [...staged].reverse()) {
      try { fs.renameSync(item.temp, item.from) } catch {}
    }
    throw new Error(`重命名失败,已回滚:${e.message}`)
  }
  return list
}

function undoPairs(pairs) {
  return pairs.map((item) => ({ from: item.to, to: item.from }))
}

function saveUndo(filePath, pairs) {
  fs.writeFileSync(filePath, JSON.stringify(pairs))
}

function loadUndo(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(data) && data.length ? data : null
  } catch {
    return null
  }
}

function clearUndo(filePath) {
  try { fs.rmSync(filePath, { force: true }) } catch {}
}

// 一次流式读取同时算三个哈希,大文件不占内存
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    let stat
    try {
      stat = fs.statSync(filePath)
    } catch {
      reject(new Error('文件不存在或无法读取'))
      return
    }
    if (!stat.isFile()) {
      reject(new Error('请选择普通文件'))
      return
    }
    const md5 = crypto.createHash('md5')
    const sha1 = crypto.createHash('sha1')
    const sha256 = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      md5.update(chunk)
      sha1.update(chunk)
      sha256.update(chunk)
    })
    stream.on('error', (e) => reject(new Error(`读取失败:${e.message}`)))
    stream.on('end', () => {
      resolve({
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sha256: sha256.digest('hex'),
        size: stat.size
      })
    })
  })
}

module.exports = {
  validateName,
  normalizePairs,
  applyRenamePlan,
  undoPairs,
  saveUndo,
  loadUndo,
  clearUndo,
  hashFile
}
