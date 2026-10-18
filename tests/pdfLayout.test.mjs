import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 渲染层工具是无 import 的纯 ESM,统一用 data URL 载入,绕开 package.json 未声明 type: module
function loadEsm(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
  return import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))
}

const { MAX_PAGE_PIXELS, pageSize, fitRect, resampleLongEdge } =
  await loadEsm('../src/renderer/src/utils/pdfLayout.js')

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}:${actual} ≠ ${expected}`)

test('pageSize 固定页面与自动横竖', () => {
  assert.deepEqual(pageSize('a4', 1200, 800, 0), [841.89, 595.28])
  assert.deepEqual(pageSize('a4', 600, 900, 0), [595.28, 841.89])
  assert.deepEqual(pageSize('a4', 600, 600, 0), [595.28, 841.89])
  assert.deepEqual(pageSize('a4p', 1200, 800, 0), [595.28, 841.89])
  assert.deepEqual(pageSize('letter', 100, 100, 0), [612, 792])
  assert.deepEqual(pageSize('letter', 800, 100, 0), [792, 612])
  assert.deepEqual(pageSize('image', 300, 200, 12), [324, 224])
  assert.throws(() => pageSize('xx', 1, 1, 0), /未知页面尺寸/)
  assert.throws(() => pageSize('a4', 0, 800, 0), /图片尺寸无效/)
  assert.throws(() => pageSize('image', 300, -1, 0), /图片尺寸无效/)
})

test('fitRect 等比适应并居中', () => {
  const wide = fitRect(1200, 800, 595.28, 841.89, 0)
  near(wide.width, 595.28, '宽度受页面宽限制')
  near(wide.height, (800 / 1200) * 595.28, '高度按比例')
  near(wide.x, 0, '无留白时贴左')
  near(wide.y, (841.89 - wide.height) / 2, '垂直居中')
  // 正方形图:A4 的窄边(宽)是限制方,左右刚好用满留白,上下仍居中
  const square = fitRect(400, 400, 595.28, 841.89, 24)
  near(square.width, 547.28, '可用宽')
  near(square.height, 547.28, '正方形保持等比')
  near(square.x, 24, '水平居中即留白边')
  near(square.y, (841.89 - 547.28) / 2, '垂直居中')
  // 高图:限制方换成高
  const tall = fitRect(300, 1200, 595.28, 841.89, 24)
  near(tall.height, 793.89, '可用高')
  near(tall.y, 24, '垂直方向用满留白')
  assert.throws(() => fitRect(10, 10, 100, 100, 60), /留白过大/)
  assert.throws(() => fitRect(10, 10, 100, 100, -1), /留白需在 0–72pt/)
  assert.throws(() => fitRect(10, 10, 100, 100, NaN), /留白需在 0–72pt/)
})

test('resampleLongEdge 按 DPI 换算长边像素并受 30MP 预算收紧', () => {
  // 841.89 / 72 * 150 = 1753.94 → 1754
  assert.equal(resampleLongEdge(595.28, 841.89, 0, 150, 1200, 800), 1754)
  assert.equal(resampleLongEdge(595.28, 841.89, 0, 150, 800, 1200), 1754)
  assert.equal(resampleLongEdge(595.28, 841.89, 24, 150, 1200, 800), 1654) // (841.89-48)/72*150
  assert.equal(resampleLongEdge(595.28, 841.89, 0, NaN, 1200, 800), 1754) // 非有限 DPI 按 150
  assert.equal(resampleLongEdge(595.28, 841.89, 0, 10, 1200, 800), 842) // 下界 72
  assert.equal(
    resampleLongEdge(595.28, 841.89, 0, 1000, 1200, 800),
    resampleLongEdge(595.28, 841.89, 0, 600, 1200, 800) // 上界 600
  )
  assert.equal(resampleLongEdge(595.28, 841.89, 0, 600, 1200, 800), 6708) // 预算 sqrt(3e7*1.5)
  // 600 DPI 的 A4 长边 7016 会让 4958×7016(34.8MP)超限,预算收紧到 6515(缩后 4604×6515 ≤ 30MP)
  const portrait = resampleLongEdge(595.28, 841.89, 0, 600, 4958, 7016)
  assert.equal(portrait, 6515)
  assert.ok(Math.floor((4958 * portrait) / 7016) * portrait <= MAX_PAGE_PIXELS, '收紧后总像素不超预算')
  assert.equal(MAX_PAGE_PIXELS, 30000000)
})

test('resampleLongEdge 收紧后按主进程的 round 缩放也不越界', () => {
  // 主进程按 round(短边 = 长边 * 比例) 缩,floor 只算到精确比例 → 取整可能顶破 30MP 导致该页被拒
  const scaledPixels = (edge, imgW, imgH) =>
    edge * Math.round((edge * Math.min(imgW, imgH)) / Math.max(imgW, imgH))
  assert.ok(scaledPixels(6918, 7115, 4460) > MAX_PAGE_PIXELS, '未收紧的 6918 确实会越界')
  for (const [imgW, imgH] of [
    [4958, 7016], [7115, 4460], [4460, 7115], [9000, 9000], [6000, 1500], [1500, 6000], [12000, 3000]
  ]) {
    const edge = resampleLongEdge(595.28, 841.89, 0, 600, imgW, imgH)
    assert.ok(scaledPixels(edge, imgW, imgH) <= MAX_PAGE_PIXELS, `${imgW}×${imgH} → ${edge} 仍越界`)
  }
  assert.equal(resampleLongEdge(595.28, 841.89, 0, 600, 7115, 4460), 6917)
})
