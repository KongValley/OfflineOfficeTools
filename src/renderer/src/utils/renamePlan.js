// 批量重命名的预览与校验。纯 ESM 无 import,主进程会再独立校验一次。
// 只改文件名,不做跨目录移动;序号、前后缀、替换都作用在扩展名之前的部分。

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/

export function splitExt(name) {
  const text = String(name)
  const dot = text.lastIndexOf('.')
  if (dot <= 0) return { stem: text, ext: '' }
  return { stem: text.slice(0, dot), ext: text.slice(dot + 1) }
}

export function dirNameOf(filePath) {
  const p = String(filePath)
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i >= 0 ? p.slice(0, i) : ''
}

export function baseNameOf(filePath) {
  return String(filePath).split(/[\\/]/).pop()
}

// 返回错误文案;合法返回 null
export function validateName(name) {
  const text = String(name ?? '')
  if (!text) return '文件名为空'
  if (text === '.' || text === '..') return '文件名无效'
  if (INVALID_CHARS.test(text)) return '包含 Windows 不允许的字符 < > : " / \\ | ? *'
  if (/[. ]$/.test(text)) return '不能以空格或点结尾'
  if (RESERVED.test(text.split('.')[0])) return '是 Windows 保留名'
  if (text.length > 255) return '文件名过长'
  return null
}

function applyCase(text, mode) {
  if (mode === 'upper') return text.toUpperCase()
  if (mode === 'lower') return text.toLowerCase()
  if (mode === 'title') return text.replace(/(^|[\s_-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase())
  return text
}

// files: [{ path, name }];opts 见下,全部可省略
// opts = {
//   find, replace, prefix, suffix, newExt, caseMode,
//   sequence: { enabled, start, step, digits, position: 'start'|'end', separator }
// }
export function buildRenamePlan(files, opts = {}) {
  const list = Array.isArray(files) ? files : []
  const prefix = String(opts.prefix ?? '')
  const suffix = String(opts.suffix ?? '')
  const find = String(opts.find ?? '')
  const replace = String(opts.replace ?? '')
  const newExt = String(opts.newExt ?? '').replace(/^\./, '')
  const caseMode = opts.caseMode || 'none'
  const seq = opts.sequence || {}
  const seqEnabled = Boolean(seq.enabled)
  const seqStart = seq.start == null || seq.start === '' ? 1 : Math.trunc(Number(seq.start))
  const seqStep = seq.step == null || seq.step === '' ? 1 : Math.trunc(Number(seq.step))
  const seqDigits = seq.digits == null || seq.digits === '' ? 2 : Math.trunc(Number(seq.digits))
  const seqPos = seq.position === 'start' ? 'start' : 'end'
  const seqSep = seq.separator == null ? '-' : String(seq.separator)

  if (seqEnabled) {
    if (!Number.isFinite(seqStart) || seqStart < 0 || seqStart > 999999) throw new Error('序号起始值无效')
    if (!Number.isFinite(seqStep) || seqStep < 1 || seqStep > 99999) throw new Error('序号步长需为 1–99999')
    if (!Number.isFinite(seqDigits) || seqDigits < 1 || seqDigits > 9) throw new Error('序号位数需为 1–9')
  }

  const plan = list.map((file, index) => {
    const path = String(file.path ?? '')
    const name = String(file.name || baseNameOf(path))
    const { stem, ext } = splitExt(name)
    let core = find ? stem.split(find).join(replace) : stem
    core = applyCase(core, caseMode)
    core = `${prefix}${core}${suffix}`
    if (seqEnabled) {
      const number = String(seqStart + index * seqStep).padStart(seqDigits, '0')
      core = seqPos === 'start' ? `${number}${seqSep}${core}` : `${core}${seqSep}${number}`
    }
    const nextExt = newExt || ext
    const to = nextExt ? `${core}.${nextExt}` : core
    return { path, from: name, to, dir: dirNameOf(path), valid: true, error: null }
  })

  // 同目录内目标名重复(Windows 不区分大小写)全部标红
  const groups = new Map()
  for (const item of plan) {
    const key = `${item.dir.toLowerCase()}|${item.to.toLowerCase()}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  for (const item of plan) {
    const nameError = validateName(item.to)
    if (nameError) {
      item.valid = false
      item.error = nameError
      continue
    }
    const key = `${item.dir.toLowerCase()}|${item.to.toLowerCase()}`
    if (groups.get(key).length > 1) {
      item.valid = false
      item.error = '与本次重命名中的其他文件重名'
    }
  }
  return plan
}
