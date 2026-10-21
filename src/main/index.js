const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const Jimp = require('jimp')
const { decodeText, encodeText } = require('./encoding')
const {
  MAX_SOURCE_PIXELS,
  imageDimensions,
  decodeEmbeddedImage,
  processJimp,
  stitchImages
} = require('./imageOps')
const {
  applyRenamePlan,
  undoPairs,
  saveUndo,
  loadUndo,
  clearUndo,
  hashFile
} = require('./fileOps')

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

// 批量重命名成功后把实际映射写进用户数据目录,撤销可以跨标签页/重启保留最近一次
const renameUndoPath = () => path.join(app.getPath('userData'), 'last-rename.json')

ipcMain.handle('file:renameBatch', (event, pairs) => {
  const applied = applyRenamePlan(pairs)
  try {
    saveUndo(renameUndoPath(), applied)
  } catch {}
  return applied
})

ipcMain.handle('file:undoRename', (event) => {
  const last = loadUndo(renameUndoPath())
  if (!last) throw new Error('没有可撤销的重命名记录')
  const applied = applyRenamePlan(undoPairs(last))
  clearUndo(renameUndoPath())
  return applied
})

ipcMain.handle('file:hashes', (event, filePath) => hashFile(filePath))

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

// 拼长图由主进程直接写目标文件:30MP 的 PNG 经 IPC 回传会再复制一份,32 位进程吃不消
ipcMain.handle('image:stitch', (event, paths, opts, targetPath) =>
  stitchImages(paths, opts, targetPath)
)

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
