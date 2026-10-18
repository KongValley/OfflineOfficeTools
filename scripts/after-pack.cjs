// electron-builder afterPack:用缓存里的 rcedit 给 exe 写图标。
// 找不到 rcedit 时只提示并跳过,不阻断构建(此时 exe 仍是 Electron 默认图标,
// 运行时窗口/任务栏图标由 BrowserWindow 的 icon 选项提供)。
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function findRcedit() {
  const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache')
  let level = [cache]
  for (let depth = 0; depth < 3; depth += 1) {
    const next = []
    for (const dir of level) {
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          next.push(full)
        } else if (entry.name === 'rcedit-x64.exe') {
          return full
        }
      }
    }
    level = next
  }
  return null
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const ico = path.join(context.packager.projectDir, 'src', 'assets', 'icon.ico')
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  const rcedit = findRcedit()
  if (!rcedit || !fs.existsSync(ico) || !fs.existsSync(exe)) {
    console.log('[afterPack] 未找到 rcedit 或图标资源,跳过 exe 图标写入(不影响运行时窗口图标)')
    return
  }
  execFileSync(rcedit, [exe, '--set-icon', ico], { stdio: 'inherit' })
  console.log(`[afterPack] 已写入 exe 图标:${path.basename(exe)}`)
}
