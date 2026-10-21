// CDP 验收:启动真实 Electron(源码态或打包 exe),用主进程 inspector 桩掉原生对话框,
// 通过渲染层 DOM 操作跑 P0 业务链路,并用 pdf-lib/Jimp/pdf.js 校验输出文件。
// 用法:node scripts/acceptance.mjs [--exe <打包exe>] [--app <dir>] [--port 9230] [--filter <名字>] [--stress] [--keep]
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream, StandardFonts, degrees } = require('pdf-lib')
const Jimp = require('jimp')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')
const iconv = require('iconv-lite')
const textLines = await import('../src/renderer/src/utils/textLines.js')
const units = await import('../src/renderer/src/utils/units.js')

const argv = process.argv.slice(2)
const valueOf = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const exePath = valueOf('--exe')
const appDir = resolve(valueOf('--app', process.cwd()))
const port = Number(valueOf('--port', 9230))
const filter = valueOf('--filter')
const runStress = argv.includes('--stress')
const keepWork = argv.includes('--keep')
const root = process.cwd()
const work = join(root, 'tmp', 'e2e')
const fixtures = join(work, 'fixtures')
const outDir = join(work, 'out')
const reportPath = join(work, 'report.json')
const electronExe = exePath
  ? resolve(exePath)
  : join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const pass = (v, msg) => assert.ok(v, msg)
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} ≠ ${expected}(±${tol})`)
const A4 = [595.28, 841.89]
const LETTER = [612, 792]

// ---------- 基础等待 ----------

async function waitFor(fn, timeout = 30000, label = '条件') {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时(${timeout}ms):${label}`)
    await sleep(50)
  }
}

async function waitFile(file, timeout = 60000) {
  await waitFor(() => existsSync(file) && statSync(file).size > 0, timeout, `文件 ${file}`)
  let last = -1
  for (let i = 0; i < 10; i += 1) {
    const size = statSync(file).size
    if (size === last && size > 0) return size
    last = size
    await sleep(100)
  }
  return last
}

// ---------- fixtures ----------

async function makeTextPdf(file, entries) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const item of entries) {
    const page = doc.addPage(item.size || A4)
    if (item.text) page.drawText(item.text, { x: 50, y: 50, size: 12, font })
    if (item.rotation) page.setRotation(degrees(item.rotation))
    if (item.crop) page.setCropBox(...item.crop)
  }
  writeFileSync(file, await doc.save())
}

const solid = (w, h, color) => new Jimp(w, h, color)

async function buildFixtures() {
  mkdirSync(fixtures, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  await makeTextPdf(join(fixtures, 'text3.pdf'), [
    { text: 'A', size: [400, 500] },
    { text: 'B', size: [300, 600] },
    { text: 'C', size: [350, 350] }
  ])
  await makeTextPdf(join(fixtures, 'text5.pdf'), ['A', 'B', 'C', 'D', 'E'].map((text) => ({ text })))
  await makeTextPdf(join(fixtures, 'src.pdf'), [{ text: 'X' }, { text: 'Y' }])
  await makeTextPdf(join(fixtures, 'mixed.pdf'), [
    { text: 'P1' },
    { text: 'P2', size: [792, 612] },
    { text: 'P3', rotation: 90 },
    { text: 'P4', size: [300, 400], crop: [10, 20, 280, 360] }
  ])

  const seal = new Jimp(200, 100, 0x00000000)
  seal.scan(0, 0, 200, 100, (x, y) => {
    const dx = x - 100
    const dy = y - 50
    if ((dx * dx) / (90 * 90) + (dy * dy) / (40 * 40) <= 1) seal.setPixelColor(0xff0000ff, x, y)
  })
  await seal.writeAsync(join(fixtures, 'seal.png'))

  await solid(300, 120, 0xffffffff).writeAsync(join(fixtures, 'sign.jpg'))

  const photo = new Jimp(400, 300, 0xffffffff)
  photo.scan(0, 0, 400, 300, (x, y) => {
    const left = x < 200
    const top = y < 150
    photo.setPixelColor(left && top ? 0xff0000ff : !left && top ? 0x00ff00ff : left ? 0x0000ffff : 0xffffffff, x, y)
  })
  await photo.writeAsync(join(fixtures, 'photo.png'))

  await solid(100, 50, 0xff0000ff).writeAsync(join(fixtures, 'strip-a.png'))
  await solid(50, 100, 0x00ff00ff).writeAsync(join(fixtures, 'strip-b.png'))
  await solid(80, 80, 0x0000ffff).writeAsync(join(fixtures, 'strip-c.png'))

  const big = new Jimp(2400, 1800, 0xffffffff)
  let seed = 123456789
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed
  }
  big.scan(0, 0, 2400, 1800, (x, y) => {
    big.setPixelColor((rnd() & 0xffffff00) | 0xff, x, y)
  })
  await big.quality(95).writeAsync(join(fixtures, 'big.jpg'))

  const gbkText = '  第一行  \r\n\r\nABC abc\r\n第三行\r\n'
  writeFileSync(join(fixtures, 'gbk.txt'), iconv.encode(gbkText, 'gbk'))

  const sections = []
  for (let i = 1; i <= 20; i += 1) {
    sections.push(`# 第一章 ${i}`, '', `正文段落 ${i}。`, '', `## 1.${i} 小节`, '', `小节内容 ${i}。`, '')
  }
  const toc = [
    '---',
    'title: 示例',
    '---',
    '',
    ...sections,
    '```js',
    '# 假标题',
    '```',
    ''
  ].join('\n')
  writeFileSync(join(fixtures, 'toc.md'), toc, 'utf8')

  writeFileSync(join(fixtures, 'hash.bin'), randomBytes(1024 * 1024))

  const line = '这是用来测试统计与防抖的文本行 abc 123。\r\n'
  writeFileSync(join(fixtures, 'big8m.txt'), line.repeat(Math.ceil(7900000 / Buffer.byteLength(line))), 'utf8')
  return gbkText
}

// ---------- PDF 校验 ----------

async function pdfInfo(buf) {
  const doc = await PDFDocument.load(buf)
  return {
    doc,
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
    pages: doc.getPages().map((page) => ({
      width: page.getCropBox().width,
      height: page.getCropBox().height,
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      crop: page.getCropBox(),
      box: page.getMediaBox()
    }))
  }
}

async function extractText(buf) {
  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  const out = []
  try {
    for (let i = 1; i <= jsDoc.numPages; i += 1) {
      const page = await jsDoc.getPage(i)
      const content = await page.getTextContent()
      out.push(content.items.map((item) => item.str).join(''))
    }
  } finally {
    jsDoc.destroy()
  }
  return out
}

function ctmMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

function ctmRect(ctm) {
  const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([px, py]) => [
    ctm[0] * px + ctm[2] * py + ctm[4],
    ctm[1] * px + ctm[3] * py + ctm[5]
  ])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys)
  }
}

async function opBoxes(buf, pageNo, kind) {
  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  try {
    const page = await jsDoc.getPage(pageNo)
    const list = await page.getOperatorList()
    const boxes = []
    let ctm = [1, 0, 0, 1, 0, 0]
    const stack = []
    for (let i = 0; i < list.fnArray.length; i += 1) {
      const fn = list.fnArray[i]
      const args = list.argsArray[i]
      if (fn === pdfjsLib.OPS.save) {
        stack.push(ctm.slice())
      } else if (fn === pdfjsLib.OPS.restore) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
      } else if (fn === pdfjsLib.OPS.transform) {
        ctm = ctmMul(ctm, args)
      } else if (fn === pdfjsLib.OPS.paintFormXObjectBegin) {
        stack.push(ctm.slice())
        if (Array.isArray(args[0]) && args[0].length === 6) {
          ctm = ctmMul(ctm, args[0])
          if (kind === 'form' && Array.isArray(args[1])) {
            const [x0, y0, x1, y1] = args[1]
            const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([px, py]) => [
              ctm[0] * px + ctm[2] * py + ctm[4],
              ctm[1] * px + ctm[3] * py + ctm[5]
            ])
            const xs = pts.map((p) => p[0])
            const ys = pts.map((p) => p[1])
            boxes.push({
              x: Math.min(...xs),
              y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys)
            })
          }
        }
      } else if (fn === pdfjsLib.OPS.paintFormXObjectEnd) {
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0]
      } else if (kind === 'image' && fn === pdfjsLib.OPS.paintImageXObject) {
        boxes.push(ctmRect(ctm))
      }
    }
    return boxes
  } finally {
    jsDoc.destroy()
  }
}

const imageBoxes = (buf, pageNo) => opBoxes(buf, pageNo, 'image')
const formBoxes = (buf, pageNo) => opBoxes(buf, pageNo, 'form')

async function textPositions(buf, pageNo) {
  const jsDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  try {
    const page = await jsDoc.getPage(pageNo)
    const content = await page.getTextContent()
    return content.items.map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5] }))
  } finally {
    jsDoc.destroy()
  }
}

async function extGStateOpacity(buf, pageNo) {
  const doc = await PDFDocument.load(buf)
  const states = doc.getPage(pageNo - 1).node.Resources().lookupMaybe(PDFName.of('ExtGState'), PDFDict)
  const found = []
  if (states) {
    for (const [, ref] of states.entries()) {
      const dict = doc.context.lookup(ref, PDFDict)
      const ca = dict.lookupMaybe(PDFName.of('ca'), PDFNumber)
      const CA = dict.lookupMaybe(PDFName.of('CA'), PDFNumber)
      found.push({ ca: ca ? ca.asNumber() : null, CA: CA ? CA.asNumber() : null })
    }
  }
  return found
}

// ---------- CDP 客户端 ----------

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const handler = this.pending.get(message.id)
      if (!handler) return
      this.pending.delete(message.id)
      handler(message)
    })
  }

  static async connect() {
    let target = null
    for (let i = 0; i < 150 && !target; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await res.json()
        target = list.find((item) => item.webSocketDebuggerUrl)
      } catch {}
      if (!target) await sleep(200)
    }
    if (!target) throw new Error('inspector 未在 30s 内监听')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      socket.addEventListener('open', res, { once: true })
      socket.addEventListener('error', rej, { once: true })
    })
    const cdp = new Cdp(socket)
    await cdp.send('Runtime.enable')
    return cdp
  }

  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP 超时:${method}`))
        }
      }, 120000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) rej(new Error(message.error.message))
        else res(message.result)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(detail)
    }
    return result.result ? result.result.value : undefined
  }

  close() {
    try { this.socket.close() } catch {}
  }
}

let child = null
let cdp = null
let captured = ''
let userDataDir = ''
let undoBackup = null
const undoName = 'last-rename.json'

const REQ = 'process.mainModule.require'
const stubScript = `(() => {
  const req = ${REQ}
  const { ipcMain, BrowserWindow } = req('electron')
  globalThis.__e2e = globalThis.__e2e || { open: [], save: [], dirs: [], console: [], gone: [] }
  globalThis.__e2e.open.length = 0
  globalThis.__e2e.save.length = 0
  globalThis.__e2e.dirs.length = 0
  globalThis.__e2e.console.length = 0
  globalThis.__e2e.gone.length = 0
  ipcMain.removeHandler('dialog:openFiles')
  ipcMain.handle('dialog:openFiles', () => globalThis.__e2e.open.shift() || [])
  ipcMain.removeHandler('dialog:saveFile')
  ipcMain.handle('dialog:saveFile', () => globalThis.__e2e.save.shift() || null)
  ipcMain.removeHandler('dialog:pickDirectory')
  ipcMain.handle('dialog:pickDirectory', () => globalThis.__e2e.dirs.shift() || null)
  const win = BrowserWindow.getAllWindows()[0]
  win.webContents.setBackgroundThrottling(false)
  win.show()
  win.focus()
  win.webContents.on('console-message', (event, level, message) => {
    if (level >= 3) globalThis.__e2e.console.push(String(message))
  })
  win.webContents.on('render-process-gone', (event, details) => {
    globalThis.__e2e.gone.push(String(details.reason))
  })
  return true
})()`

const pageInit = `(() => {
  const e = window.__e2e = window.__e2e || { logs: [], errors: [] }
  e.logs.length = 0
  e.errors = e.errors || []
  window.alert = (message) => e.logs.push(String(message))
  window.confirm = (message) => { e.logs.push('confirm:' + String(message)); return true }
  window.addEventListener('error', (event) => e.errors.push(String(event.message)))
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    e.errors.push(String((reason && reason.message) || reason))
  })
  const rootOf = (cardTitle) => cardTitle
    ? [...document.querySelectorAll('.card')].find((card) => {
        const title = card.querySelector('.card-title')
        return title && title.textContent.trim() === cardTitle
      })
    : document.querySelector('.panel')
  const need = (value, label) => { if (!value) throw new Error('缺少元素:' + label); return value }
  const holderOf = (root, label) => {
    const labels = [...root.querySelectorAll('label')]
    return labels.find((item) => item.textContent.trim().startsWith(label)) ||
      labels.find((item) => item.textContent.includes(label))
  }
  e.root = rootOf
  e.tab = (label) => {
    const button = [...document.querySelectorAll('.tab')].find((item) => item.textContent.trim() === label)
    need(button, 'tab ' + label).click()
    return true
  }
  e.btn = (text, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
    need(button, 'button ' + text).click()
    return true
  }
  e.btnDisabled = (text, cardTitle) => {
    const root = rootOf(cardTitle)
    const button = [...root.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
    return button ? button.disabled : null
  }
  e.field = (label, value, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const holder = holderOf(root, label)
    const element = holder && holder.querySelector('input,select,textarea')
    need(element, 'field ' + label)
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.ph = (placeholder, value, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const element = [...root.querySelectorAll('input,textarea')].find((item) => item.placeholder === placeholder)
    need(element, 'placeholder ' + placeholder)
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.val = (label, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const holder = holderOf(root, label)
    const element = holder && holder.querySelector('input,select,textarea')
    return element ? element.value : null
  }
  e.select = (label, optionText, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const holder = holderOf(root, label)
    const select = holder && holder.querySelector('select')
    need(select, 'select ' + label)
    const option = [...select.options].find((item) => item.textContent.trim() === optionText)
    need(option, 'option ' + optionText)
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.selectIndex = (cardTitle, index, optionText) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const select = root.querySelectorAll('select')[index]
    need(select, 'select#' + index)
    const option = [...select.options].find((item) => item.textContent.trim() === optionText)
    need(option, 'option ' + optionText)
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.inputIndex = (cardTitle, index, value) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const element = root.querySelectorAll('input[type=number],input[type=text]')[index]
    need(element, 'input#' + index)
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.check = (label, on, cardTitle) => {
    const root = need(rootOf(cardTitle), 'card ' + cardTitle)
    const holder = holderOf(root, label)
    const box = holder && holder.querySelector('input[type=checkbox]')
    need(box, 'checkbox ' + label)
    box.checked = on
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  e.text = (cardTitle) => {
    const root = rootOf(cardTitle)
    return root ? root.innerText : ''
  }
  e.value = (selector) => need(document.querySelector(selector), selector).value
  e.setValue = (selector, value) => {
    const element = need(document.querySelector(selector), selector)
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  return true
})()`

async function evalMain(expression) {
  return cdp.eval(expression)
}

async function evalPage(expression) {
  const wrapped = `(async () => {
    const { BrowserWindow } = ${REQ}('electron')
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('窗口不存在')
    return win.webContents.executeJavaScript(${JSON.stringify(expression)}, true)
  })()`
  try {
    return await evalMain(wrapped)
  } catch (error) {
    const snippet = String(expression).replace(/\s+/g, ' ').slice(0, 240)
    throw new Error(`${error.message} | 页面脚本:${snippet}`)
  }
}

async function launch() {
  captured = ''
  const args = [`--inspect=${port}`]
  if (!exePath) args.push(appDir)
  child = spawn(electronExe, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (data) => { captured += data })
  child.stderr.on('data', (data) => { captured += data })
  child.on('exit', (code) => { captured += `\n[exit ${code}]` })
  cdp = await Cdp.connect()
  await waitFor(
    () => evalMain(`${REQ}('electron').BrowserWindow.getAllWindows().length`).then((n) => n > 0),
    30000,
    '应用窗口'
  )
  await evalMain(stubScript)
  await evalPage(pageInit)
  if (!userDataDir) {
    userDataDir = await evalMain(`${REQ}('electron').app.getPath('userData')`)
    const undoFile = join(userDataDir, undoName)
    undoBackup = existsSync(undoFile) ? readFileSync(undoFile) : null
  }
}

async function closeApp() {
  try { await evalMain(`${REQ}('electron').app.quit()`) } catch {}
  await new Promise((res) => {
    if (!child || child.exitCode != null) return res()
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      res()
    }, 10000)
    child.once('exit', () => { clearTimeout(timer); res() })
  })
  if (cdp) cdp.close()
  cdp = null
}

// ---------- 场景操作 ----------

const q = (v) => JSON.stringify(v)
const baseName = (p) => String(p).split(/[\\/]/).pop()

async function reset() {
  await evalMain(`(() => {
    globalThis.__e2e.open.length = 0
    globalThis.__e2e.save.length = 0
    globalThis.__e2e.dirs.length = 0
    globalThis.__e2e.console.length = 0
    globalThis.__e2e.gone.length = 0
    return true
  })()`)
  await evalPage(`window.__e2e.logs.length = 0; window.__e2e.errors.length = 0; true`)
}

async function queueOpen(paths) {
  await evalMain(`globalThis.__e2e.open.push(${q(paths)}); true`)
}

async function queueSave(path) {
  await evalMain(`globalThis.__e2e.save.push(${q(path)}); true`)
}

async function queueDir(path) {
  await evalMain(`globalThis.__e2e.dirs.push(${q(path)}); true`)
}

async function clickTab(label) {
  await evalPage(`__e2e.tab(${q(label)})`)
  await sleep(150)
}

async function clickBtn(text, cardTitle = null) {
  await evalPage(`__e2e.btn(${q(text)}, ${q(cardTitle)})`)
  await sleep(80)
}

async function setField(label, value, cardTitle = null) {
  await evalPage(`__e2e.field(${q(label)}, ${q(String(value))}, ${q(cardTitle)})`)
  await sleep(40)
}

async function setPh(placeholder, value, cardTitle = null) {
  await evalPage(`__e2e.ph(${q(placeholder)}, ${q(String(value))}, ${q(cardTitle)})`)
  await sleep(40)
}

async function selectBy(label, optionText, cardTitle = null) {
  await evalPage(`__e2e.select(${q(label)}, ${q(optionText)}, ${q(cardTitle)})`)
  await sleep(80)
}

async function checkBy(label, on, cardTitle = null) {
  await evalPage(`__e2e.check(${q(label)}, ${on ? 'true' : 'false'}, ${q(cardTitle)})`)
  await sleep(80)
}

async function panelText(cardTitle = null) {
  return evalPage(`__e2e.text(${q(cardTitle)})`)
}

async function logs() {
  return evalPage(`window.__e2e.logs.slice()`)
}

async function waitText(substr, cardTitle = null, timeout = 20000) {
  await waitFor(async () => (await panelText(cardTitle)).includes(substr), timeout, `文本「${substr}」`)
}

async function expectLog(pattern, timeout = 20000) {
  return waitFor(async () => (await logs()).find((line) => pattern.test(line)), timeout, `日志 ${pattern}`)
}

async function openPdf(file) {
  await queueOpen([file])
  await clickBtn('选择 PDF')
  await waitText(baseName(file), null, 30000)
}

async function openImages(files) {
  await queueOpen(files)
  await clickBtn('选择图片')
  await waitText(baseName(files[0]), null, 30000)
}

async function saveAs(path, buttonText, cardTitle = null, timeout = 60000) {
  await queueSave(path)
  await clickBtn(buttonText, cardTitle)
  await waitFile(path, timeout)
  await expectLog(/已保存|已导出/)
}

async function imageInfo(file) {
  const img = await Jimp.read(file)
  return { img, width: img.bitmap.width, height: img.bitmap.height }
}

const outputs = (name) => join(outDir, name)

// ---------- 场景 ----------

const results = []

async function scenario(name, fn) {
  if (filter && !name.includes(filter)) return
  await reset()
  const started = Date.now()
  try {
    await fn()
    const pageErrors = await evalPage(`window.__e2e.errors.slice()`)
    const consoleErrors = await evalMain(`globalThis.__e2e.console.slice()`)
    const gone = await evalMain(`globalThis.__e2e.gone.slice()`)
    if (gone.length) throw new Error(`渲染进程退出:${gone.join(',')}`)
    if (pageErrors.length) throw new Error(`页面异常:${pageErrors.join(' | ')}`)
    if (consoleErrors.length) throw new Error(`控制台错误:${consoleErrors.join(' | ')}`)
    const ms = Date.now() - started
    results.push({ name, ok: true, ms })
    console.log(`PASS ${name} (${ms}ms)`)
  } catch (error) {
    const ms = Date.now() - started
    let tail = []
    try { tail = await logs() } catch {}
    results.push({ name, ok: false, ms, error: error.message, logs: tail })
    console.error(`FAIL ${name} (${ms}ms): ${error.message}`)
    if (tail.length) console.error(`  logs: ${tail.slice(-3).join(' | ')}`)
  }
}

async function pdfScenarios() {
  await clickTab('PDF 整理')

  await scenario('pdf-load', async () => {
    await openPdf(join(fixtures, 'mixed.pdf'))
    await waitText('4 页')
  })

  await scenario('pdf-meta', async () => {
    await openPdf(join(fixtures, 'text3.pdf'))
    await setField('标题', '合同标题', '文档信息')
    await setField('作者', '作者甲', '文档信息')
    await setField('主题', '测试主题', '文档信息')
    await setField('关键词', '合同，2026;重要', '文档信息')
    const target = outputs('meta.pdf')
    await saveAs(target, '保存元数据', '文档信息', 30000)
    const info = await pdfInfo(readFileSync(target))
    assert.equal(info.title, '合同标题')
    assert.equal(info.author, '作者甲')
    assert.equal(info.subject, '测试主题')
    assert.equal(info.keywords, '合同 2026 重要')

    await openPdf(target)
    await waitText('3 页')
    assert.equal(await evalPage(`__e2e.val('关键词', '文档信息')`), '合同, 2026, 重要')

    const cleared = outputs('meta-clear.pdf')
    await saveAs(cleared, '清除元数据', '文档信息', 30000)
    const empty = await pdfInfo(readFileSync(cleared))
    assert.equal(empty.title, '')
    assert.equal(empty.author, '')
    assert.equal(empty.subject, '')
    assert.equal(empty.keywords, '')
  })

  await scenario('pdf-stamp-pos', async () => {
    await openPdf(join(fixtures, 'text5.pdf'))
    await queueOpen([join(fixtures, 'seal.png')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('seal.png', '图片盖章 / 签名')
    await selectBy('位置', '右下', '图片盖章 / 签名')
    await setField('宽度 %', '30', '图片盖章 / 签名')
    await selectBy('角度(逆时针)', '0°', '图片盖章 / 签名')
    await setField('边距 pt', '24', '图片盖章 / 签名')
    await setField('透明度', '1', '图片盖章 / 签名')
    const w = 0.3 * A4[0]
    const h = (w * 100) / 200
    const positions = [
      ['左上', 24, A4[1] - 24 - h],
      ['上中', (A4[0] - w) / 2, A4[1] - 24 - h],
      ['右上', A4[0] - 24 - w, A4[1] - 24 - h],
      ['左中', 24, (A4[1] - h) / 2],
      ['居中', (A4[0] - w) / 2, (A4[1] - h) / 2],
      ['右中', A4[0] - 24 - w, (A4[1] - h) / 2],
      ['左下', 24, 24],
      ['下中', (A4[0] - w) / 2, 24],
      ['右下', A4[0] - 24 - w, 24]
    ]
    for (const [label, x, y] of positions) {
      await selectBy('位置', label, '图片盖章 / 签名')
      const target = outputs(`stamp-${label}.pdf`)
      await saveAs(target, '盖章并保存', '图片盖章 / 签名')
      const bytes = readFileSync(target)
      const boxes = await imageBoxes(bytes, 1)
      assert.equal(boxes.length, 1, `${label} 页 1 图片数`)
      const box = boxes[0]
      near(box.x, x, 1, `${label} x`)
      near(box.y, y, 1, `${label} y`)
      near(box.w, w, 1, `${label} w`)
      near(box.h, h, 1, `${label} h`)
    }
  })

  await scenario('pdf-stamp-page', async () => {
    await openPdf(join(fixtures, 'text5.pdf'))
    await queueOpen([join(fixtures, 'seal.png')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('seal.png', '图片盖章 / 签名')
    await setField('页码范围', '1,3-4', '图片盖章 / 签名')
    const target = outputs('stamp-range.pdf')
    await saveAs(target, '盖章并保存', '图片盖章 / 签名')
    const bytes = readFileSync(target)
    const counts = []
    for (let page = 1; page <= 5; page += 1) counts.push((await imageBoxes(bytes, page)).length)
    assert.deepEqual(counts, [1, 0, 1, 1, 0])
  })

  await scenario('pdf-stamp-params', async () => {
    await openPdf(join(fixtures, 'text5.pdf'))
    await queueOpen([join(fixtures, 'seal.png')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('seal.png', '图片盖章 / 签名')
    await selectBy('位置', '右下', '图片盖章 / 签名')
    await setField('宽度 %', '20', '图片盖章 / 签名')
    await setField('边距 pt', '10', '图片盖章 / 签名')
    await selectBy('角度(逆时针)', '30°', '图片盖章 / 签名')
    await setField('透明度', '0.5', '图片盖章 / 签名')
    await setField('页码范围', '1', '图片盖章 / 签名')
    const target = outputs('stamp-params.pdf')
    await saveAs(target, '盖章并保存', '图片盖章 / 签名')

    const bytes = readFileSync(target)
    const boxes = await imageBoxes(bytes, 1)
    assert.equal(boxes.length, 1)
    const width = 0.2 * A4[0]
    const height = width / 2
    const rad = (30 * Math.PI) / 180
    const bboxW = width * Math.cos(rad) + height * Math.sin(rad)
    const bboxH = width * Math.sin(rad) + height * Math.cos(rad)
    const box = boxes[0]
    near(box.w, bboxW, 1, '旋转后宽')
    near(box.h, bboxH, 1, '旋转后高')
    near(box.x + box.w / 2, A4[0] - 10 - bboxW / 2, 1, '右下中心 x')
    near(box.y + box.h / 2, 10 + bboxH / 2, 1, '右下中心 y')
    const states = await extGStateOpacity(bytes, 1)
    assert.ok(states.some((item) => item.ca != null && Math.abs(item.ca - 0.5) < 1e-6), JSON.stringify(states))
  })

  await scenario('pdf-stamp-jpg', async () => {
    await openPdf(join(fixtures, 'text3.pdf'))
    await queueOpen([join(fixtures, 'sign.jpg')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('sign.jpg', '图片盖章 / 签名')
    const target = outputs('stamp-jpg.pdf')
    await saveAs(target, '盖章并保存', '图片盖章 / 签名')
    const bytes = readFileSync(target)
    assert.equal((await imageBoxes(bytes, 1)).length, 1)
  })

  await scenario('pdf-stamp-rotate', async () => {
    await openPdf(join(fixtures, 'mixed.pdf'))
    await queueOpen([join(fixtures, 'seal.png')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('seal.png', '图片盖章 / 签名')
    await selectBy('位置', '右下', '图片盖章 / 签名')
    await setField('宽度 %', '30', '图片盖章 / 签名')
    await selectBy('角度(逆时针)', '0°', '图片盖章 / 签名')
    await setField('边距 pt', '24', '图片盖章 / 签名')
    await setField('透明度', '1', '图片盖章 / 签名')
    await setField('页码范围', '3', '图片盖章 / 签名')
    const target = outputs('stamp-rotate.pdf')
    await saveAs(target, '盖章并保存', '图片盖章 / 签名')

    const bytes = readFileSync(target)
    const boxes = await imageBoxes(bytes, 3)
    assert.equal(boxes.length, 1)
    const visualW = A4[1]
    const visualH = A4[0]
    const width = 0.3 * visualW
    const height = width / 2
    const box = boxes[0]
    near(box.w, height, 1, '页面宽高互换')
    near(box.h, width, 1, '页面宽高互换')
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    near(cx, A4[0] - (24 + height / 2), 1, '页面中心 x')
    near(cy, visualW - 24 - width / 2, 1, '页面中心 y')
    const visualU = cy
    const visualV = A4[0] - cx
    assert.ok(visualU > (visualW * 2) / 3, `可见中心 u=${visualU}`)
    assert.ok(visualV < visualH / 3, `可见中心 v=${visualV}`)
  })

  await scenario('pdf-stamp-crop', async () => {
    await openPdf(join(fixtures, 'mixed.pdf'))
    await queueOpen([join(fixtures, 'seal.png')])
    await clickBtn('选择图片', '图片盖章 / 签名')
    await waitText('seal.png', '图片盖章 / 签名')
    await selectBy('位置', '居中', '图片盖章 / 签名')
    await setField('页码范围', '4', '图片盖章 / 签名')
    const target = outputs('stamp-crop.pdf')
    await saveAs(target, '盖章并保存', '图片盖章 / 签名')
    const bytes = readFileSync(target)
    const boxes = await imageBoxes(bytes, 4)
    assert.equal(boxes.length, 1)
    const box = boxes[0]
    assert.ok(box.x >= 10 - 0.5 && box.y >= 20 - 0.5, JSON.stringify(box))
    assert.ok(box.x + box.w <= 290 + 0.5 && box.y + box.h <= 380 + 0.5, JSON.stringify(box))
  })

  await scenario('pdf-insert-pdf', async () => {
    await openPdf(join(fixtures, 'text3.pdf'))
    await queueOpen([join(fixtures, 'src.pdf')])
    await clickBtn('选择要插入的 PDF')
    await waitText('src.pdf')
    await setField('插入位置', '1')
    await setPh('源页码范围,留空=全部', '1-2')
    const target = outputs('insert.pdf')
    await saveAs(target, '插入所选页')
    const texts = await extractText(readFileSync(target))
    assert.deepEqual(texts.map((t) => t.trim()), ['A', 'X', 'Y', 'B', 'C'])
  })

  await scenario('pdf-insert-blank', async () => {
    await openPdf(join(fixtures, 'text3.pdf'))
    await setField('插入位置', '0')
    await setField('空白页数', '1')
    await selectBy('尺寸', 'A4')
    const first = outputs('blank1.pdf')
    await saveAs(first, '插入空白页')

    await openPdf(first)
    await setField('插入位置', '')
    await setField('空白页数', '1')
    await selectBy('尺寸', '同前一页')
    const second = outputs('blank2.pdf')
    await saveAs(second, '插入空白页')

    const info = await pdfInfo(readFileSync(second))
    assert.equal(info.pages.length, 5)
    near(info.pages[0].width, A4[0], 0.01, '首页宽')
    near(info.pages[0].height, A4[1], 0.01, '首页高')
    near(info.pages[4].width, 350, 0.01, '末页宽')
    near(info.pages[4].height, 350, 0.01, '末页高')
  })

  await scenario('pdf-nup', async () => {
    await openPdf(join(fixtures, 'text5.pdf'))
    const two = outputs('nup2.pdf')
    await saveAs(two, '生成拼版 PDF')
    let info = await pdfInfo(readFileSync(two))
    assert.equal(info.pages.length, 3)
    near(info.pages[0].width, A4[1], 0.01, '2合1 横向宽')
    near(info.pages[0].height, A4[0], 0.01, '2合1 横向高')
    let counts = []
    for (let page = 1; page <= 3; page += 1) counts.push((await formBoxes(readFileSync(two), page)).length)
    assert.deepEqual(counts, [2, 2, 1])

    await selectBy('每张页数', '4 页')
    await selectBy('纸张', 'Letter')
    await selectBy('方向', '纵向')
    await selectBy('顺序', '先列后行')
    const four = outputs('nup4.pdf')
    await saveAs(four, '生成拼版 PDF')
    const bytes = readFileSync(four)
    info = await pdfInfo(bytes)
    assert.equal(info.pages.length, 2)
    near(info.pages[0].width, LETTER[0], 0.01, '4合1 Letter 宽')
    near(info.pages[0].height, LETTER[1], 0.01, '4合1 Letter 高')
    assert.equal((await formBoxes(bytes, 1)).length, 4)
    const positions = await textPositions(bytes, 1)
    const find = (name) => positions.find((item) => item.str.trim() === name)
    const leftTop = find('A')
    const leftBottom = find('B')
    const rightTop = find('C')
    assert.ok(leftTop && leftBottom && rightTop, '拼版文字缺失')
    assert.ok(leftTop.x < LETTER[0] / 2 && leftBottom.x < LETTER[0] / 2, '先列后行:A/B 应在左列')
    assert.ok(rightTop.x > LETTER[0] / 2, '先列后行:C 应在右列')
  })

  await scenario('pdf-unify', async () => {
    await openPdf(join(fixtures, 'mixed.pdf'))
    await selectBy('模式', '统一页面尺寸')
    await selectBy('纸张', 'A4')
    await selectBy('方向', '自动(按每页)')
    const target = outputs('unify.pdf')
    await saveAs(target, '统一尺寸并保存')
    const bytes = readFileSync(target)
    const info = await pdfInfo(bytes)
    const shapes = info.pages.map((page) => (page.width > page.height ? 'landscape' : 'portrait'))
    assert.deepEqual(shapes, ['portrait', 'landscape', 'landscape', 'portrait'])
    for (const page of info.pages) {
      const portrait = page.width < page.height
      near(page.width, portrait ? A4[0] : A4[1], 0.01, '统一宽')
      near(page.height, portrait ? A4[1] : A4[0], 0.01, '统一高')
    }
    const sourceAspects = [A4[0] / A4[1], 792 / 612, A4[1] / A4[0], 280 / 360]
    for (let page = 1; page <= 4; page += 1) {
      const boxes = await formBoxes(bytes, page)
      assert.ok(boxes.length >= 1, `第 ${page} 页应有嵌入页`)
      const box = boxes[0]
      assert.ok(box.x >= 11.5 && box.y >= 11.5, `第 ${page} 页左边距 ${JSON.stringify(box)}`)
      assert.ok(box.x + box.w <= info.pages[page - 1].width - 11.5, `第 ${page} 页右边距`)
      assert.ok(box.y + box.h <= info.pages[page - 1].height - 11.5, `第 ${page} 页上边距`)
      near(box.w / box.h, sourceAspects[page - 1], 0.015, `第 ${page} 页宽高比`)
    }
  })

  await scenario('pdf-range', async () => {
    await openPdf(join(fixtures, 'text5.pdf'))
    await selectBy('模式', '拼版(多页合一)')
    await selectBy('每张页数', '2 页')
    await selectBy('纸张', 'A4')
    await selectBy('方向', '自动')
    await selectBy('顺序', '先行后列')
    await setField('页码范围', '2-3', '拼版 / 页面尺寸')
    const nup = outputs('range-nup.pdf')
    await saveAs(nup, '生成拼版 PDF')
    const nupBytes = readFileSync(nup)
    const nupInfo = await pdfInfo(nupBytes)
    assert.equal(nupInfo.pages.length, 1)
    assert.equal((await formBoxes(nupBytes, 1)).length, 2)

    await selectBy('模式', '统一页面尺寸')
    await setField('页码范围', '1', '拼版 / 页面尺寸')
    const fit = outputs('range-fit.pdf')
    await saveAs(fit, '统一尺寸并保存')
    const fitInfo = await pdfInfo(readFileSync(fit))
    assert.equal(fitInfo.pages.length, 1)
    near(fitInfo.pages[0].width, A4[0], 0.01, '范围统一宽')
    near(fitInfo.pages[0].height, A4[1], 0.01, '范围统一高')
  })
}

async function imageScenarios() {
  await clickTab('图片工具')

  await scenario('img-compress', async () => {
    await openImages([join(fixtures, 'big.jpg')])
    await setField('目标 KB', '200', '压缩到指定大小')
    const first = outputs('compress-200.jpg')
    await saveAs(first, '压缩并保存', '压缩到指定大小', 120000)
    assert.ok(statSync(first).size <= 200 * 1024, `200KB 输出 ${statSync(first).size}`)
    await imageInfo(first)

    await setField('目标 KB', '50', '压缩到指定大小')
    const second = outputs('compress-50.jpg')
    await saveAs(second, '压缩并保存', '压缩到指定大小', 120000)
    assert.ok(statSync(second).size <= 50 * 1024, `50KB 输出 ${statSync(second).size}`)
    await imageInfo(second)
  })

  await scenario('img-compress-alpha', async () => {
    await openImages([join(fixtures, 'seal.png')])
    await setField('目标 KB', '50', '压缩到指定大小')
    const target = outputs('compress-alpha.jpg')
    await saveAs(target, '压缩并保存', '压缩到指定大小', 120000)
    const { img, width } = await imageInfo(target)
    assert.ok(width > 0)
    const corner = Jimp.intToRGBA(img.getPixelColor(0, 0))
    assert.ok(corner.r > 250 && corner.g > 250 && corner.b > 250, JSON.stringify(corner))
  })

  await scenario('img-crop', async () => {
    await openImages([join(fixtures, 'photo.png')])
    await setField('上', '10', '裁剪 / 证件照')
    await setField('下', '10', '裁剪 / 证件照')
    await setField('左', '10', '裁剪 / 证件照')
    await setField('右', '10', '裁剪 / 证件照')
    const margins = outputs('crop-margins.png')
    await saveAs(margins, '裁剪并保存', '裁剪 / 证件照')
    let info = await imageInfo(margins)
    assert.equal(info.width, 380)
    assert.equal(info.height, 280)
    const corner = Jimp.intToRGBA(info.img.getPixelColor(0, 0))
    assert.ok(corner.r > 240 && corner.g < 20 && corner.b < 20, '左上角仍为红色')

    await selectBy('方式', '按比例', '裁剪 / 证件照')
    await selectBy('比例', '1:1', '裁剪 / 证件照')
    const square = outputs('crop-square.png')
    await saveAs(square, '裁剪并保存', '裁剪 / 证件照')
    info = await imageInfo(square)
    assert.equal(info.width, 300)
    assert.equal(info.height, 300)

    await selectBy('方式', '证件照', '裁剪 / 证件照')
    await selectBy('尺寸', '一寸 295×413', '裁剪 / 证件照')
    const preset = outputs('crop-id.png')
    await saveAs(preset, '裁剪并保存', '裁剪 / 证件照')
    info = await imageInfo(preset)
    assert.equal(info.width, 295)
    assert.equal(info.height, 413)
  })

  await scenario('img-stitch', async () => {
    await openImages([
      join(fixtures, 'strip-a.png'),
      join(fixtures, 'strip-b.png'),
      join(fixtures, 'strip-c.png')
    ])
    await setField('统一宽度 px', '100', '拼长图')
    await setField('间距 px', '5', '拼长图')
    await selectBy('背景', '白色', '拼长图')
    await selectBy('格式', 'PNG', '拼长图')
    const target = outputs('stitch.png')
    await queueSave(target)
    await clickBtn('拼成一张并保存', '拼长图')
    await waitFile(target)
    await expectLog(/已保存|像素/)
    const info = await imageInfo(target)
    assert.equal(info.width, 100)
    assert.equal(info.height, 360)
    const a = Jimp.intToRGBA(info.img.getPixelColor(10, 10))
    const gap = Jimp.intToRGBA(info.img.getPixelColor(10, 52))
    const b = Jimp.intToRGBA(info.img.getPixelColor(10, 100))
    const c = Jimp.intToRGBA(info.img.getPixelColor(10, 300))
    assert.ok(a.r > 240 && a.g < 20, '第一张红色')
    assert.ok(gap.r > 240 && gap.g > 240 && gap.b > 240, '间隔白色')
    assert.ok(b.g > 240 && b.r < 20, '第二张绿色')
    assert.ok(c.b > 240 && c.r < 20, '第三张蓝色')
  })

  await scenario('img-stitch-no-upscale', async () => {
    await openImages([
      join(fixtures, 'strip-a.png'),
      join(fixtures, 'strip-b.png'),
      join(fixtures, 'strip-c.png')
    ])
    await setField('统一宽度 px', '100', '拼长图')
    await setField('间距 px', '5', '拼长图')
    await checkBy('小图不放大', true, '拼长图')
    const target = outputs('stitch-keep.png')
    await queueSave(target)
    await clickBtn('拼成一张并保存', '拼长图')
    await waitFile(target)
    const info = await imageInfo(target)
    assert.equal(info.width, 100)
    assert.equal(info.height, 240)
    const side = Jimp.intToRGBA(info.img.getPixelColor(0, 60))
    const middle = Jimp.intToRGBA(info.img.getPixelColor(25, 60))
    const last = Jimp.intToRGBA(info.img.getPixelColor(10, 160))
    assert.ok(side.r > 240 && side.g > 240 && side.b > 240, '左侧留白')
    assert.ok(middle.g > 240 && middle.r < 20, '绿色图居中')
    assert.ok(last.b > 240 && last.r < 20, '蓝色图原尺寸')
  })

  await scenario('img-stitch-limit', async () => {
    await openImages([
      join(fixtures, 'strip-a.png'),
      join(fixtures, 'strip-b.png'),
      join(fixtures, 'strip-c.png')
    ])
    await setField('统一宽度 px', '20000', '拼长图')
    await checkBy('小图不放大', false, '拼长图')
    const target = outputs('stitch-limit.png')
    await queueSave(target)
    await clickBtn('拼成一张并保存', '拼长图')
    await expectLog(/20000|3000 万/)
    assert.ok(!existsSync(target), '超限不应写文件')
    // 进程仍可交互
    assert.ok((await panelText('拼长图')).includes('拼成一张并保存'))
  })

  await scenario('img-watermark', async () => {
    await openImages([join(fixtures, 'photo.png')])
    await setField('文字', '内部资料', '文字水印')
    await selectBy('颜色', '红', '文字水印')
    await selectBy('位置', '居中', '文字水印')
    await selectBy('角度', '45°', '文字水印')
    await checkBy('平铺', false, '文字水印')
    const target = outputs('watermark.png')
    await queueSave(target)
    await clickBtn('加水印并保存', '文字水印')
    await waitFile(target)
    await expectLog(/已保存/)
    const { img, width, height } = await imageInfo(target)
    assert.equal(width, 400)
    assert.equal(height, 300)
    const original = await Jimp.read(join(fixtures, 'photo.png'))
    let diff = 0
    img.scan(0, 0, width, height, (x, y) => {
      if (img.getPixelColor(x, y) !== original.getPixelColor(x, y)) diff += 1
    })
    assert.ok(diff > 1000, `水印像素差异 ${diff}`)
  })

  await scenario('img-watermark-batch', async () => {
    await openImages([join(fixtures, 'photo.png'), join(fixtures, 'strip-a.png')])
    await setField('文字', '内部资料', '文字水印')
    const dir = join(work, 'watermark-batch')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await queueDir(dir)
    await clickBtn('加水印并保存', '文字水印')
    await waitFor(() => readdirSync(dir).length >= 2, 60000, '批量水印输出')
    const files = readdirSync(dir)
    assert.deepEqual(files.sort(), ['photo_水印.png', 'strip-a_水印.png'])
    for (const file of files) {
      const { width, height } = await imageInfo(join(dir, file))
      assert.ok(width > 0 && height > 0)
    }
  })

  await scenario('img-regress', async () => {
    await openImages([join(fixtures, 'photo.png')])
    const rotated = outputs('rotate.png')
    await saveAs(rotated, '右旋 90° 并保存')
    let info = await imageInfo(rotated)
    assert.equal(info.width, 300)
    assert.equal(info.height, 400)

    await setField('缩放 %', '50')
    const scaled = outputs('scale.png')
    await saveAs(scaled, '按当前参数保存')
    info = await imageInfo(scaled)
    assert.equal(info.width, 200)
    assert.equal(info.height, 150)

    await setField('缩放 %', '')
    await selectBy('格式', 'JPEG')
    const jpg = outputs('format.jpg')
    await saveAs(jpg, '按当前参数保存')
    const img = await Jimp.read(jpg)
    assert.equal(img.getMIME(), Jimp.MIME_JPEG)

    await queueSave(outputs('images.pdf'))
    await clickBtn('合成 PDF')
    const pdfPath = outputs('images.pdf')
    await waitFile(pdfPath, 60000)
    const pdf = await pdfInfo(readFileSync(pdfPath))
    assert.equal(pdf.pages.length, 1)
    const landscape = pdf.pages[0].width > pdf.pages[0].height
    near(pdf.pages[0].width, landscape ? A4[1] : A4[0], 0.01, '合成 PDF 宽')
    near(pdf.pages[0].height, landscape ? A4[0] : A4[1], 0.01, '合成 PDF 高')
  })
}

async function fileScenarios() {
  const freshDir = (name) => {
    const dir = join(work, 'rename', name)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    return dir
  }

  await clickTab('文件工具')

  const clearRename = async () => {
    try { await evalPage(`__e2e.btn('清空')`) } catch {}
    await checkBy('加序号', false)
    await setPh('前缀', '')
    await setPh('后缀', '')
    await setPh('查找(区分大小写)', '')
    await setPh('替换为', '')
    await setField('新扩展名', '')
    await sleep(80)
  }

  await scenario('file-rename', async () => {
    await clearRename()
    const dir = freshDir('basic')
    writeFileSync(join(dir, 'a.txt'), 'AAA')
    writeFileSync(join(dir, 'b.txt'), 'BBB')
    await queueOpen([join(dir, 'a.txt'), join(dir, 'b.txt')])
    await clickBtn('选择文件')
    await waitText('a.txt')
    await setPh('前缀', '新_')
    await checkBy('加序号', true)
    await sleep(120)
    await setField('新扩展名', 'md')
    await waitText('新_a-01.md')
    await clickBtn('执行重命名')
    await expectLog(/已重命名/)
    assert.deepEqual(readdirSync(dir).sort(), ['新_a-01.md', '新_b-02.md'])
    assert.equal(readFileSync(join(dir, '新_a-01.md'), 'utf8'), 'AAA')
    assert.equal(readFileSync(join(dir, '新_b-02.md'), 'utf8'), 'BBB')
  })

  await scenario('file-undo', async () => {
    assert.deepEqual(readdirSync(join(work, 'rename', 'basic')).sort(), ['新_a-01.md', '新_b-02.md'])
    await clickBtn('撤销上次重命名')
    await expectLog(/已撤销/)
    assert.deepEqual(readdirSync(join(work, 'rename', 'basic')).sort(), ['a.txt', 'b.txt'])
  })

  await scenario('file-undo-restart', async () => {
    await clearRename()
    const dir = freshDir('restart')
    writeFileSync(join(dir, 'a.txt'), 'AAA')
    writeFileSync(join(dir, 'b.txt'), 'BBB')
    await queueOpen([join(dir, 'a.txt'), join(dir, 'b.txt')])
    await clickBtn('选择文件')
    await waitText('a.txt')
    await setPh('前缀', '重_')
    await clickBtn('执行重命名')
    await expectLog(/已重命名/)
    assert.deepEqual(readdirSync(dir).sort(), ['重_a.txt', '重_b.txt'])

    await closeApp()
    await launch()
    await clickTab('文件工具')
    await clickBtn('撤销上次重命名')
    await expectLog(/已撤销/)
    assert.deepEqual(readdirSync(dir).sort(), ['a.txt', 'b.txt'])
  })

  await scenario('file-case', async () => {
    await clearRename()
    const dir = freshDir('case')
    writeFileSync(join(dir, 'a.txt'), 'AAA')
    await queueOpen([join(dir, 'a.txt')])
    await clickBtn('选择文件')
    await waitText('a.txt')
    await setPh('查找(区分大小写)', 'a')
    await setPh('替换为', 'A')
    await waitText('A.txt')
    await clickBtn('执行重命名')
    await expectLog(/已重命名/)
    assert.deepEqual(readdirSync(dir), ['A.txt'])
  })

  await scenario('file-conflict', async () => {
    await clearRename()
    const dir = freshDir('conflict')
    writeFileSync(join(dir, 'x.txt'), 'X')
    writeFileSync(join(dir, 'y.txt'), 'Y')
    await queueOpen([join(dir, 'y.txt')])
    await clickBtn('选择文件')
    await waitText('y.txt')
    await setPh('查找(区分大小写)', 'y')
    await setPh('替换为', 'x')
    await clickBtn('执行重命名')
    await expectLog(/目标文件已存在/)
    assert.ok(existsSync(join(dir, 'y.txt')), '源文件应保留')
    assert.equal(readFileSync(join(dir, 'x.txt'), 'utf8'), 'X')
  })

  await scenario('file-invalid', async () => {
    await clearRename()
    const dir = freshDir('invalid')
    writeFileSync(join(dir, 'a.txt'), 'A')
    writeFileSync(join(dir, 'note'), 'N')
    await queueOpen([join(dir, 'a.txt')])
    await clickBtn('选择文件')
    await waitText('a.txt')

    await setPh('查找(区分大小写)', 'a')
    await setPh('替换为', 'CON')
    await sleep(120)
    assert.equal(await evalPage(`__e2e.btnDisabled('执行重命名')`), true, '保留名应禁用执行')
    await waitText('需要修正')

    await setPh('替换为', 'a:b')
    await sleep(120)
    assert.equal(await evalPage(`__e2e.btnDisabled('执行重命名')`), true, '非法字符应禁用执行')

    await queueOpen([join(dir, 'note')])
    await clickBtn('选择文件')
    await waitText('note')
    await setPh('查找(区分大小写)', 'note')
    await setPh('替换为', 'note.')
    await sleep(120)
    assert.equal(await evalPage(`__e2e.btnDisabled('执行重命名')`), true, '结尾点应禁用执行')
  })
}

async function textScenarios() {
  await clickTab('文本工具')

  await scenario('text-gbk', async () => {
    const decoded = '  第一行  \r\n\r\nABC abc\r\n第三行\r\n'
    await queueOpen([join(fixtures, 'gbk.txt')])
    await clickBtn('选择文本文件')
    await waitText('GBK', null, 30000)
    const stats = textLines.textStats(decoded)
    await waitText(`共 ${stats.chars} 字`, null, 15000)
    const statsText = await panelText()
    assert.ok(statsText.includes(`不含空白 ${stats.charsNoSpace}`), statsText)
    assert.ok(statsText.includes(`中文 ${stats.cjk} 字`), statsText)
    assert.ok(statsText.includes(`英文单词 ${stats.words}`), statsText)
    assert.ok(statsText.includes(`${stats.nonEmptyLines} 行`), statsText)
    assert.ok(statsText.includes(`${stats.paragraphs} 段`), statsText)

    await selectBy('保存为', 'GBK')
    await setPh('行前缀', 'P-')
    await setPh('行后缀', '-S')
    let expected = textLines.prefixSuffixLines(decoded, 'P-', '-S')
    await clickBtn('加前后缀')
    let target = outputs('text-affix.txt')
    await saveAs(target, '仅转换编码并保存')
    assert.equal(iconv.decode(readFileSync(target), 'gbk'), expected)

    await clickBtn('加行号')
    expected = textLines.addLineNumbers(expected, 1, '. ')
    target = outputs('text-number.txt')
    await saveAs(target, '仅转换编码并保存')
    assert.equal(iconv.decode(readFileSync(target), 'gbk'), expected)
    assert.ok(expected.includes('\r\n\r\n'), '空行应保留且不占号')

    await selectBy('大小写', '全部大写')
    await clickBtn('转换')
    expected = textLines.changeCase(expected, 'upper')
    await clickBtn('转全角')
    expected = textLines.toFullWidth(expected)
    await clickBtn('去行首尾空白')
    expected = textLines.trimLineSides(expected)
    target = outputs('text-final.txt')
    await saveAs(target, '仅转换编码并保存')
    const bytes = readFileSync(target)
    assert.equal(iconv.decode(bytes, 'gbk'), expected)
    assert.ok(bytes.includes(Buffer.from('\r\n')), '换行风格仍为 CRLF')
  })

  await scenario('text-8mb', async () => {
    await queueOpen([join(fixtures, 'big8m.txt')])
    await clickBtn('选择文本文件')
    await waitText('big8m', null, 60000)
    await waitText('共 ', null, 30000)
    const timing = await evalPage(`(async () => {
      const ta = document.querySelector('.panel textarea')
      const label = () => [...document.querySelectorAll('.panel .hint')].find((el) => el.textContent.includes('共 '))
      const before = label() ? label().textContent : ''
      const original = window.setTimeout
      let firedDelay = -1
      let workMs = -1
      window.setTimeout = function (fn, ms, ...args) {
        if (ms === 250 && typeof fn === 'function') {
          const scheduled = performance.now()
          return original.call(window, () => {
            const begin = performance.now()
            try { fn(...args) } finally {
              firedDelay = begin - scheduled
              workMs = performance.now() - begin
            }
          }, ms, ...args)
        }
        return original.call(window, fn, ms, ...args)
      }
      const start = performance.now()
      ta.focus()
      const end = ta.value.length
      ta.setSelectionRange(end, end)
      const inserted = document.execCommand('insertText', false, '测')
      if (!inserted) {
        ta.value += '测'
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          const el = label()
          if (el && el.textContent !== before) { clearInterval(timer); resolve() }
          if (performance.now() - start > 10000) { clearInterval(timer); reject(new Error('统计未更新')) }
        }, 50)
      })
      const done = performance.now()
      window.setTimeout = original
      return { firedDelay, workMs, total: done - start, inserted }
    })()`)
    // 用 execCommand 模拟真实按键插入;直接给 textarea.value 追加会整块重写 8MB,测到的是重排而不是输入。
    console.log(`  8MB 统计耗时 ${Math.round(timing.total)}ms (防抖延迟 ${Math.round(timing.firedDelay)} / 计算 ${Math.round(timing.workMs)} / execCommand=${timing.inserted})`)
    assert.ok(timing.workMs < 1000, `8MB 统计计算 ${timing.workMs}ms`)
    assert.ok(timing.total < 2000, `8MB 统计耗时 ${timing.total}ms`)
  })
}

async function mdScenarios() {
  await clickTab('Markdown')

  await scenario('md-toc', async () => {
    await queueOpen([join(fixtures, 'toc.md')])
    await clickBtn('打开 .md 文件')
    await waitFor(async () => (await evalPage(`__e2e.value('.panel textarea')`)).includes('第一章 1'), 20000, 'Markdown 载入')
    await clickBtn('插入/更新目录')
    await sleep(300)
    const source = await evalPage(`__e2e.value('.panel textarea')`)
    assert.equal((source.match(/oot-toc\)/g) || []).length, 1)
    assert.equal((source.match(/oot-toc-end\)/g) || []).length, 1)

    const htmlPath = outputs('toc.html')
    await saveAs(htmlPath, '导出为 HTML')
    const html = readFileSync(htmlPath, 'utf8')
    assert.ok(!html.includes('title: 示例'), 'front matter 不应导出')
    assert.ok(!html.includes('>假标题<'), '围栏代码里的 # 不应成为标题')
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))
    const ids = new Set([...html.matchAll(/<h[1-6][^>]*id="([^"]+)"/g)].map((m) => m[1]))
    assert.ok(hrefs.length > 0, '目录应有链接')
    for (const href of hrefs) assert.ok(ids.has(href), `目录锚点缺少标题 id:${href}`)

    await sleep(400)
    const scrolled = await evalPage(`(async () => {
      const links = [...document.querySelectorAll('.preview a[href^="#"]')]
      if (!links.length) throw new Error('预览没有目录链接')
      links[links.length - 1].click()
      await new Promise((resolve) => setTimeout(resolve, 900))
      return document.querySelector('.preview').scrollTop
    })()`)
    assert.ok(scrolled > 0, `预览未滚动:${scrolled}`)
  })

  await scenario('md-pdf', async () => {
    const target = outputs('toc.pdf')
    await saveAs(target, '导出为 PDF', null, 60000)
    assert.ok(statSync(target).size > 1000)
    const texts = await extractText(readFileSync(target))
    const joined = texts.join('')
    assert.ok(joined.includes('第一章'), 'PDF 应含正文标题')
    assert.ok(joined.includes('1.1 小节'), 'PDF 应含目录项')
  })
}

async function calcScenarios() {
  await clickTab('小工具')

  await scenario('calc-units', async () => {
    const cases = [
      ['长度', 'length', 1, '米 m', '千米 km', 'm', 'km'],
      ['面积', 'area', 1, '平方米 m²', '亩', 'm2', 'mu'],
      ['重量', 'weight', 1, '千克 kg', '斤', 'kg', 'jin'],
      ['体积', 'volume', 1, '升 L', '毫升 mL', 'l', 'ml'],
      ['温度', 'temperature', 100, '摄氏度 °C', '华氏度 °F', 'c', 'f'],
      ['温度', 'temperature', 100, '摄氏度 °C', '开尔文 K', 'c', 'k'],
      ['存储', 'data', 1, 'MB(1024)', 'KB(1024)', 'mb', 'kb']
    ]
    for (const [categoryLabel, categoryId, value, fromLabel, toLabel, fromId, toId] of cases) {
      await selectBy('类别', categoryLabel, '单位换算')
      await sleep(120)
      await evalPage(`__e2e.selectIndex('单位换算', 1, ${q(fromLabel)})`)
      await evalPage(`__e2e.selectIndex('单位换算', 2, ${q(toLabel)})`)
      await evalPage(`__e2e.inputIndex('单位换算', 0, ${q(String(value))})`)
      await sleep(120)
      const shown = await evalPage(`__e2e.root('单位换算').querySelector('.calc-out').textContent.trim()`)
      assert.equal(shown, units.formatNumber(units.convert(value, categoryId, fromId, toId)), `${categoryLabel} ${fromLabel}→${toLabel}`)
    }
  })

  await scenario('calc-hash', async () => {
    const file = join(fixtures, 'hash.bin')
    await queueOpen([file])
    await evalPage(`__e2e.btn('选择文件', '文件校验(MD5 / SHA-1 / SHA-256)')`)
    await waitFor(async () => (await evalPage(`document.querySelectorAll('.hashval code').length`)) === 3, 20000, '哈希结果')
    const shown = await evalPage(`[...document.querySelectorAll('.hashval code')].map((el) => el.textContent)`)
    const data = readFileSync(file)
    assert.deepEqual(shown, [
      createHash('md5').update(data).digest('hex'),
      createHash('sha1').update(data).digest('hex'),
      createHash('sha256').update(data).digest('hex')
    ])
  })
}

// ---------- 压力场景 ----------

async function makeStressFixtures() {
  const dir = join(work, 'stress')
  mkdirSync(dir, { recursive: true })
  const hugeImage = join(dir, '30mp.jpg')
  if (!existsSync(hugeImage)) await solid(5477, 5477, 0x336699ff).quality(90).writeAsync(hugeImage)
  const many = []
  for (let i = 1; i <= 30; i += 1) {
    const file = join(dir, `s-${String(i).padStart(2, '0')}.png`)
    if (!existsSync(file)) await solid(300, 300, (i * 99991) & 0xffffff00 | 0xff).writeAsync(file)
    many.push(file)
  }
  const hugePdf = join(dir, 'huge.pdf')
  if (!existsSync(hugePdf)) {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    doc.addPage(A4).drawText('HUGE', { x: 50, y: 50, size: 12, font })
    const bytes = new Uint8Array(180 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 32
    const stream = PDFRawStream.of(doc.context.obj({ Length: bytes.length }), bytes)
    doc.context.register(stream)
    writeFileSync(hugePdf, await doc.save())
  }
  return { dir, hugeImage, many, hugePdf }
}

async function sampled(ms, fn) {
  let peak = 0
  let running = true
  const sampler = (async () => {
    while (running) {
      try { peak = Math.max(peak, await evalMain('process.memoryUsage().rss')) } catch {}
      await sleep(ms)
    }
  })()
  try {
    const result = await fn()
    return { result, peak }
  } finally {
    running = false
    await sampler
  }
}

async function stressScenarios() {
  if (!runStress) return
  const { hugeImage, many, hugePdf } = await makeStressFixtures()

  await clickTab('图片工具')
  await scenario('stress-30mp', async () => {
    await openImages([hugeImage])
    await setField('目标 KB', '200', '压缩到指定大小')
    const target = outputs('stress-30mp.jpg')
    const started = Date.now()
    const { peak } = await sampled(500, async () => {
      await saveAs(target, '压缩并保存', '压缩到指定大小', 300000)
    })
    const ms = Date.now() - started
    assert.ok(statSync(target).size <= 200 * 1024)
    await imageInfo(target)
    console.log(`  30MP 压缩 ${ms}ms, RSS 峰值 ${Math.round(peak / 1048576)}MB`)
    assert.ok(peak < 1.8e9, `RSS 峰值 ${peak}`)
  })

  await scenario('stress-stitch', async () => {
    await openImages(many)
    await setField('统一宽度 px', '500', '拼长图')
    await setField('间距 px', '0', '拼长图')
    const target = outputs('stress-stitch.png')
    const started = Date.now()
    const { peak } = await sampled(500, async () => {
      await queueSave(target)
      await clickBtn('拼成一张并保存', '拼长图')
      await waitFile(target, 300000)
    })
    const info = await imageInfo(target)
    assert.equal(info.width, 500)
    assert.equal(info.height, 15000)
    console.log(`  30 张拼图 ${Date.now() - started}ms, RSS 峰值 ${Math.round(peak / 1048576)}MB`)
    assert.ok(peak < 1.8e9, `RSS 峰值 ${peak}`)
  })

  await clickTab('PDF 整理')
  await scenario('stress-200mb', async () => {
    const started = Date.now()
    await openPdf(hugePdf)
    const target = outputs('stress-huge.pdf')
    const { peak } = await sampled(500, async () => {
      await saveAs(target, '添加页码并保存', null, 600000)
    })
    const info = await pdfInfo(readFileSync(target))
    assert.equal(info.pages.length, 1)
    console.log(`  190MB PDF ${Date.now() - started}ms, RSS 峰值 ${Math.round(peak / 1048576)}MB`)
    assert.ok(peak < 1.8e9, `RSS 峰值 ${peak}`)
  })
}

// ---------- main ----------

async function main() {
  if (!exePath && !existsSync(join(appDir, 'dist', 'renderer', 'index.html'))) {
    throw new Error('dist/renderer/index.html 不存在,先运行 npm run build')
  }
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  await buildFixtures()

  await launch()
  try {
    await pdfScenarios()
    await imageScenarios()
    await fileScenarios()
    await textScenarios()
    await mdScenarios()
    await calcScenarios()
    await stressScenarios()
  } finally {
    if (userDataDir) {
      const undoFile = join(userDataDir, undoName)
      try {
        if (undoBackup == null) rmSync(undoFile, { force: true })
        else writeFileSync(undoFile, undoBackup)
      } catch {}
    }
    await closeApp()
  }

  const failed = results.filter((item) => !item.ok)
  writeFileSync(reportPath, JSON.stringify({ exe: exePath || 'source', results }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} 通过;报告 ${reportPath}`)
  if (!keepWork && !failed.length) rmSync(work, { recursive: true, force: true })
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error.message)
  if (captured) console.error(captured.slice(-4000))
  process.exitCode = 1
})
