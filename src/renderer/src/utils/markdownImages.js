// Markdown 本地图片内联:相对路径转 data URL,预览与导出的单文件 HTML/PDF 才能离线显示
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon'
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }

// 超过这个大小的图片不内联,保留原 src,避免几十 MB 的 data URL 反复进 HTML
const MAX_INLINE_BYTES = 4 * 1024 * 1024
// 所有内联图合计上限;超预算的图片保持相对路径(预览与导出都不内联)
const MAX_INLINE_TOTAL = 24 * 1024 * 1024
// 绝对路径 → data URL。预览每次防抖重渲染都会走这里,缓存避免重复 IPC + base64;
// 磁盘上替换同名图片后需重启应用才会刷新,离线工具场景可接受
const dataUrlCache = new Map()
let cachedBytes = 0

function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m] || m)
}

// 仅处理无协议、非 / 开头的相对路径;返回绝对路径或 null
export function resolveLocalPath(baseDir, src) {
  if (!baseDir) return null
  const clean = decodeEntities(src).replace(/[?#].*$/, '')
  if (!clean || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean) || clean.startsWith('//') || clean.startsWith('/')) {
    return null
  }
  let rel
  try {
    rel = decodeURIComponent(clean)
  } catch {
    rel = clean
  }
  const sep = baseDir.includes('\\') ? '\\' : '/'
  const parts = baseDir.split(/[\\/]/)
  for (const part of rel.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join(sep)
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

// 把渲染结果里指向本地相对路径的 <img src> 换成 data URL;失败保持原样
export async function inlineLocalImages(html, baseDir) {
  if (!baseDir) return html
  const re = /<img\b[^>]*\bsrc="([^"]*)"/g
  const jobs = []
  let m
  while ((m = re.exec(html))) jobs.push({ full: m[0], src: m[1], index: m.index })
  if (!jobs.length) return html
  const replacements = new Map()
  await Promise.all(jobs.map(async (job) => {
    const abs = resolveLocalPath(baseDir, job.src)
    if (!abs) return
    const ext = (abs.match(/\.([a-zA-Z0-9]+)$/) || [])[1]
    const mime = ext ? IMAGE_MIME[ext.toLowerCase()] : null
    if (!mime) return
    try {
      let dataUrl = dataUrlCache.get(abs)
      if (!dataUrl) {
        const data = await window.api.readFile(abs)
        if (data.byteLength > MAX_INLINE_BYTES) return
        dataUrl = `data:${mime};base64,${arrayBufferToBase64(data)}`
        if (cachedBytes + dataUrl.length > MAX_INLINE_TOTAL) return
        cachedBytes += dataUrl.length
        dataUrlCache.set(abs, dataUrl)
      }
      replacements.set(job, job.full.replace(`src="${job.src}"`, `src="${dataUrl}"`))
    } catch {
      /* 读取失败时保留原 src */
    }
  }))
  let out = ''
  let last = 0
  for (const job of jobs) {
    if (!replacements.has(job)) continue
    out += html.slice(last, job.index) + replacements.get(job)
    last = job.index + job.full.length
  }
  return out + html.slice(last)
}
