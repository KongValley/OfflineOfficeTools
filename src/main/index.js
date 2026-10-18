const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const Jimp = require('jimp')
const { decodeText, encodeText } = require('./encoding')

// Win7 老显卡/驱动下 GPU 进程易黑屏,直接关硬件加速
app.disableHardwareAcceleration()

const RENDERER_HTML = path.join(__dirname, '../../dist/renderer/index.html')
const APP_ICON = path.join(__dirname, '../assets/icon.ico')

function createWindow() {
  // 老机器常见 1366×768,窗口不要超出工作区
  const area = screen.getPrimaryDisplay().workAreaSize
  const win = new BrowserWindow({
    width: Math.min(1200, area.width - 24),
    height: Math.min(800, area.height - 48),
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // Markdown 预览里的链接不能让主窗口被导航走(会丢 keep-alive 状态);http(s) 交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
  })
  win.loadFile(RENDERER_HTML)
}

app.whenReady().then(() => {
  // 任务栏图标与分组用 AppUserModelID,需与 electron-builder 的 appId 一致
  app.setAppUserModelId('com.offline.office-tools')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

// 写入时重名自动加 -1 / -2 后缀,禁静默覆盖
function uniquePath(dir, name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = path.join(dir, name)
  let n = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${n}${ext}`)
    n += 1
  }
  return candidate
}

const MAX_IMAGE_PIXELS = 30000000    // image:processFile 最终尺寸上限(约 120MB RGBA)
const MAX_IMAGE_SIDE = 20000         // 单边上限
const MAX_SOURCE_PIXELS = 48000000   // 图片工具读入上限(约 190MB RGBA,4800 万像素)
const MAX_EMBEDDED_PIXELS = 36000000 // PDF 内嵌图解码上限(600 DPI A4 约 3490 万像素)
const PREVIEW_MAX_PIXELS = 12000000  // 超过此像素只报尺寸,不做整图解码预览

ipcMain.handle('dialog:openFiles', async (event, opts = {}) => {
  const res = await dialog.showOpenDialog({
    filters: opts.filters,
    properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile']
  })
  return res.canceled ? [] : res.filePaths
})

ipcMain.handle('dialog:saveFile', async (event, opts = {}) => {
  const res = await dialog.showSaveDialog({ defaultPath: opts.defaultName, filters: opts.filters })
  return res.canceled ? null : res.filePath
})

ipcMain.handle('dialog:pickDirectory', async () => {
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return res.canceled ? null : res.filePaths[0]
})

ipcMain.handle('file:read', (event, filePath) => toArrayBuffer(fs.readFileSync(filePath)))

ipcMain.handle('file:write', (event, filePath, data) => {
  fs.writeFileSync(filePath, Buffer.from(data))
  return true
})

// 逐页/逐段立即落盘,避免把全部输出攒在渲染层内存里
ipcMain.handle('file:writeUnique', (event, dir, name, data) => {
  const target = uniquePath(dir, name)
  fs.writeFileSync(target, Buffer.from(data))
  return target
})

ipcMain.handle('file:size', (event, filePath) => fs.statSync(filePath).size)

// 编码转换走主进程。Electron 内置的 Node 是 small-icu,Buffer 不支持 GBK,
// 且 Chromium 的 TextEncoder 只能输出 UTF-8,所以 GBK 编解码必须用 iconv-lite。
ipcMain.handle('text:decode', (event, data, encoding) => decodeText(Buffer.from(data), encoding))

ipcMain.handle('text:encode', (event, text, encoding) => toArrayBuffer(encodeText(text, encoding)))

// 中文字体只从系统字体目录取,用于页码/水印等需要 CJK 的 PDF 文字
ipcMain.handle('font:loadCjk', () => {
  const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')
  for (const name of ['simhei.ttf', 'simkai.ttf', 'simfang.ttf']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return toArrayBuffer(fs.readFileSync(p))
  }
  throw new Error('未找到中文字体(simhei/simkai/simfang),该功能不可用')
})

const todoPath = () => path.join(app.getPath('userData'), 'todos.json')

ipcMain.handle('todo:load', () => {
  try {
    const list = JSON.parse(fs.readFileSync(todoPath(), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
})

ipcMain.handle('todo:save', (event, list) => {
  if (!Array.isArray(list)) return false
  fs.writeFileSync(todoPath(), JSON.stringify(list, null, 2))
  return true
})

// Markdown 导出 PDF:临时 HTML 在隐藏窗口里排版,Chromium 直接输出 PDF
ipcMain.handle('md:toPdf', async (event, html, targetPath) => {
  const tmp = path.join(app.getPath('temp'), `offline-office-md-${process.pid}-${Date.now()}.html`)
  fs.writeFileSync(tmp, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, nodeIntegration: false, contextIsolation: true }
  })
  try {
    await win.loadFile(tmp)
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' })
    fs.writeFileSync(targetPath, pdf)
    return true
  } finally {
    win.destroy()
    fs.rmSync(tmp, { force: true })
  }
})

// 解码前从文件头读 PNG/JPEG/BMP/GIF 尺寸,避免超大图在 Jimp 解码阶段就吃满内存
function imageDimensions(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  if (buf.length > 26 && buf.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1
        continue
      }
      const marker = buf[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = buf.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      i += 2 + len
    }
  }
  return null
}

// 按 /Filter 与尺寸解码 PDF 内嵌图为 Jimp 实例;裸采样按 Gray/RGB 展开。
// 渲染层只在压缩时把 u8 数据送到这里,拿回的是成品 JPEG,不再持有 RGBA。
async function decodeEmbeddedImage(data, opts = {}) {
  const filters = opts.filters || []
  const unsupported = filters.find((f) => !['DCTDecode', 'FlateDecode'].includes(f))
  if (unsupported) throw new Error(`不支持的图像过滤器:${unsupported}`)
  const isDct = filters.includes('DCTDecode')
  const hasRawSamples = Boolean(opts.width && opts.height)
  if (!isDct && hasRawSamples) {
    const { width, height } = opts
    if (width * height > MAX_EMBEDDED_PIXELS) throw new Error('图像过大(超过 3600 万像素),已跳过')
    let buf = Buffer.from(data)
    if (filters.includes('FlateDecode')) buf = zlib.inflateSync(buf)
    const channels = opts.colorSpace === '/DeviceGray' ? 1 : 3
    if (buf.length < width * height * channels) throw new Error('图像数据长度不足')
    const rgba = Buffer.alloc(width * height * 4, 255)
    for (let i = 0, j = 0; i < width * height; i += 1, j += 4) {
      rgba[j] = buf[i * channels]
      rgba[j + 1] = buf[i * channels + (channels === 1 ? 0 : 1)]
      rgba[j + 2] = buf[i * channels + (channels === 1 ? 0 : 2)]
    }
    // 裸采样不是封装格式,Jimp.read 只认文件头,必须直接构造位图
    return new Jimp({ data: rgba, width, height })
  }
  const buf = Buffer.from(data)
  const dim = imageDimensions(buf)
  if (dim && dim.width * dim.height > MAX_EMBEDDED_PIXELS) {
    throw new Error('图像过大(超过 3600 万像素),已跳过')
  }
  const image = await Jimp.read(buf)
  if (image.bitmap.width * image.bitmap.height > MAX_EMBEDDED_PIXELS) {
    throw new Error('图像过大(超过 3600 万像素),已跳过')
  }
  return image
}

// image:processFile 的共用逻辑:旋转(正=界面顺时针)、最大边、百分比缩放、最终上限
async function processJimp(image, op) {
  if (image.bitmap.width * image.bitmap.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片超过 4800 万像素,已拒绝处理')
  }
  // 未指定目标格式时保持源格式:否则 JPEG 会被重编码成 PNG,体积反而暴涨;
  // GIF 同理:jimp 只读首帧且不支持写 GIF,退回 PNG
  const sourceMime = image.getMIME()
  const mime = op.mime || (sourceMime === 'image/gif' ? Jimp.MIME_PNG : sourceMime)
  // jimp 的 background 会在 rotate 扩画布时用来填空白角;JPEG 不支持透明,先铺白避免黑角
  if (mime === Jimp.MIME_JPEG) image.background(0xffffffff)
  // jimp 的第二个参数是 resize:传 false 会保持原画布尺寸,旋转后的内容会被裁掉
  // jimp 的正角度是逆时针(rotate(+90) 让右上角落到左上角),而界面上的"右旋"是顺时针,
  // 所以这里取负号,让界面语义与实际方向一致
  if (op.rotate) {
    const deg = Number(op.rotate)
    if (!Number.isFinite(deg)) throw new Error('旋转角度无效')
    image.rotate(-deg)
  }
  if (op.maxEdge) {
    const edge = Number(op.maxEdge)
    if (!Number.isFinite(edge) || edge < 16 || edge > MAX_IMAGE_SIDE) {
      throw new Error('最大边长需在 16–20000 像素之间')
    }
    const longest = Math.max(image.bitmap.width, image.bitmap.height)
    if (longest > edge) {
      const scale = edge / longest
      image.resize(
        Math.max(1, Math.round(image.bitmap.width * scale)),
        Math.max(1, Math.round(image.bitmap.height * scale))
      )
    }
  }
  if (op.scalePercent) {
    const percent = Number(op.scalePercent)
    if (!Number.isFinite(percent) || percent < 1 || percent > 400) {
      throw new Error('缩放比例需在 1%–400% 之间')
    }
    const w = Math.max(1, Math.round((image.bitmap.width * percent) / 100))
    const h = Math.max(1, Math.round((image.bitmap.height * percent) / 100))
    image.resize(w, h)
  }
  if (
    image.bitmap.width > MAX_IMAGE_SIDE ||
    image.bitmap.height > MAX_IMAGE_SIDE ||
    image.bitmap.width * image.bitmap.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('图片尺寸超出限制(单边 20000 像素或 3000 万像素)')
  }
  if (op.quality != null && mime === Jimp.MIME_JPEG) image.quality(op.quality)
  const buf = await image.getBufferAsync(mime)
  return { data: toArrayBuffer(buf), mime }
}

// 图片处理在主进程跑:jimp 依赖 Node buffer/stream,放渲染层需要一整套 polyfill。
// 路径型入口让渲染层只保留路径与 240px 预览,不再持有原图字节。
ipcMain.handle('image:processFile', async (event, filePath, op = {}) => {
  const buf = fs.readFileSync(filePath)
  const dim = imageDimensions(buf)
  if (dim && dim.width * dim.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片超过 4800 万像素,已拒绝处理')
  }
  return processJimp(await Jimp.read(buf), op)
})

ipcMain.handle('image:previewFile', async (event, filePath) => {
  const fileBuf = fs.readFileSync(filePath)
  const size = fileBuf.length
  const dim = imageDimensions(fileBuf)
  if (dim && dim.width * dim.height > MAX_SOURCE_PIXELS) {
    throw new Error('图片超过 4800 万像素,无法预览')
  }
  // 大图不做整图解码预览:老 CPU 上 20–50MP 解一次要几百毫秒到数秒,
  // 卡片只显示尺寸/大小,处理时再解码
  if (dim && dim.width * dim.height > PREVIEW_MAX_PIXELS) {
    return { dataUrl: '', width: dim.width, height: dim.height, size, skipped: true }
  }
  const image = await Jimp.read(fileBuf)
  const width = image.bitmap.width
  const height = image.bitmap.height
  if (width * height > MAX_SOURCE_PIXELS) throw new Error('图片超过 4800 万像素,无法预览')
  if (width * height > PREVIEW_MAX_PIXELS) {
    return { dataUrl: '', width, height, size, skipped: true }
  }
  const scale = Math.min(1, 240 / Math.max(width, height))
  if (scale < 1) {
    image.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
  }
  const buf = await image.getBufferAsync(Jimp.MIME_PNG)
  return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, width, height, size, skipped: false }
})

// PDF 内嵌图:解码 + 可选降采样 + 直接出 JPEG,渲染层只拿到几十 KB 的结果
ipcMain.handle('image:embeddedJpeg', async (event, data, opts = {}) => {
  const image = await decodeEmbeddedImage(data, opts)
  const maxWidth = Number(opts.maxWidth)
  if (Number.isFinite(maxWidth) && maxWidth >= 1 && image.bitmap.width > maxWidth) {
    image.resize(maxWidth, Math.max(1, Math.round(image.bitmap.height * (maxWidth / image.bitmap.width))))
  }
  image.quality(Number.isFinite(Number(opts.quality)) ? Number(opts.quality) : 75)
  const width = image.bitmap.width
  const height = image.bitmap.height
  const buf = await image.getBufferAsync(Jimp.MIME_JPEG)
  return { data: toArrayBuffer(buf), width, height }
})

// SMask 是否全不透明,在主进程扫描 alpha,避免把 RGBA 传回渲染层
ipcMain.handle('image:isOpaque', async (event, data, opts = {}) => {
  const image = await decodeEmbeddedImage(data, opts)
  const bytes = image.bitmap.data
  for (let i = 3; i < bytes.length; i += 4) if (bytes[i] !== 255) return false
  return true
})
