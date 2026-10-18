export function parseDate(text) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text).trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date
}

export function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function daysBetween(a, b) {
  return Math.round((b - a) / 86400000)
}

// 两端都算,只数周一至周五
export function workdaysBetween(a, b) {
  const lo = a <= b ? a : b
  const hi = a <= b ? b : a
  let n = 0
  for (let t = lo.getTime(); t <= hi.getTime(); t += 86400000) {
    const wd = new Date(t).getDay()
    if (wd !== 0 && wd !== 6) n += 1
  }
  return n
}

export function wholeMonthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0)
}

// 从起始日次日开始数 n 个工作日,返回截止日与跨过的周末天数
export function addWorkdays(start, n) {
  let d = start
  let left = n
  let weekends = 0
  while (left > 0) {
    d = addDays(d, 1)
    const wd = d.getDay()
    if (wd === 0 || wd === 6) weekends += 1
    else left -= 1
  }
  return { date: d, weekends }
}
