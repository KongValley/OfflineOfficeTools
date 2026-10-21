import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const Jimp = require('jimp')
const { processJimp, stitchImages } = require('../src/main/imageOps.js')

const solid = (w, h, color) => new Jimp(w, h, color)
const decode = async (data) => Jimp.read(Buffer.from(data))

test('裁剪:边距与比例', async () => {
  const margin = await processJimp(solid(100, 80, 0xff0000ff), {
    crop: { type: 'margins', top: 10, bottom: 10, left: 10, right: 10 },
    mime: Jimp.MIME_PNG
  })
  const a = await decode(margin.data)
  assert.equal(a.bitmap.width, 80)
  assert.equal(a.bitmap.height, 60)

  const square = await processJimp(solid(100, 80, 0xff0000ff), {
    crop: { type: 'aspect', ratio: 1 },
    mime: Jimp.MIME_PNG
  })
  const b = await decode(square.data)
  assert.equal(b.bitmap.width, 80)
  assert.equal(b.bitmap.height, 80)

  await assert.rejects(
    () => processJimp(solid(100, 80, 0xff0000ff), { crop: { type: 'margins', left: 60, right: 60 } }),
    /没有剩余内容/
  )
})

test('证件照预设输出精确像素', async () => {
  const out = await processJimp(solid(600, 800, 0x00ff00ff), {
    crop: { type: 'preset', width: 295, height: 413 },
    mime: Jimp.MIME_PNG
  })
  const img = await decode(out.data)
  assert.equal(img.bitmap.width, 295)
  assert.equal(img.bitmap.height, 413)
})

test('压缩到指定 KB 且结果可读', async () => {
  const img = new Jimp(800, 600)
  img.scan(0, 0, 800, 600, function (x, y, idx) {
    this.bitmap.data[idx] = (x * 7 + y * 13) % 256
    this.bitmap.data[idx + 1] = (x * 17 + y * 3) % 256
    this.bitmap.data[idx + 2] = (x * 5 + y * 29) % 256
    this.bitmap.data[idx + 3] = 255
  })
  const target = 20 * 1024
  const out = await processJimp(img, { targetBytes: target })
  assert.equal(out.mime, Jimp.MIME_JPEG)
  assert.ok(out.data.byteLength <= target, `输出 ${out.data.byteLength} 字节超过 ${target}`)
  const decoded = await decode(out.data)
  assert.ok(decoded.bitmap.width > 0 && decoded.bitmap.height > 0)
})

test('30MP JPEG 不再被 jpeg-js 默认解码预算拒绝', async () => {
  // imageOps 在加载时把 Jimp 的 JPEG 解码预算从 512MB 提到 1024MB
  const jpg = await solid(5477, 5477, 0x336699ff).quality(80).getBufferAsync(Jimp.MIME_JPEG)
  const image = await Jimp.read(jpg)
  assert.equal(image.bitmap.width, 5477)
  assert.equal(image.bitmap.height, 5477)

  // 目标 KB 模式先按目标大小降到工作像素,避免 32 位进程反复整图编码耗尽堆
  const result = await processJimp(image, { targetBytes: 200 * 1024 })
  assert.ok(result.data.byteLength <= 200 * 1024, `输出 ${result.data.byteLength}`)
  const out = await Jimp.read(Buffer.from(result.data))
  assert.ok(out.bitmap.width * out.bitmap.height <= 12000000)
})

test('拼长图纵向尺寸、背景与顺序', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oot-stitch-'))
  try {
    const p1 = join(dir, '1.png')
    const p2 = join(dir, '2.png')
    const out = join(dir, 'out.png')
    await solid(100, 50, 0xff0000ff).writeAsync(p1)
    await solid(100, 50, 0x0000ffff).writeAsync(p2)
    const result = await stitchImages([p1, p2], {
      direction: 'vertical', width: 100, gap: 10, background: 0xffffffff, mime: Jimp.MIME_PNG
    }, out)
    assert.equal(result.width, 100)
    assert.equal(result.height, 110)
    assert.ok(existsSync(out))
    const img = await Jimp.read(out)
    const top = Jimp.intToRGBA(img.getPixelColor(10, 10))
    const gap = Jimp.intToRGBA(img.getPixelColor(10, 55))
    const bottom = Jimp.intToRGBA(img.getPixelColor(10, 90))
    assert.ok(top.r > 240 && top.b < 20, '第一张在顶部且为红色')
    assert.ok(gap.r > 240 && gap.g > 240 && gap.b > 240, '间隔为白色')
    assert.ok(bottom.b > 240 && bottom.r < 20, '第二张在底部且为蓝色')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拼长图可选不放大,小图居中留白', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oot-stitch-'))
  try {
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.png')
    const c = join(dir, 'c.png')
    await solid(100, 50, 0xff0000ff).writeAsync(a)
    await solid(50, 100, 0x00ff00ff).writeAsync(b)
    await solid(80, 80, 0x0000ffff).writeAsync(c)

    const out = join(dir, 'keep.png')
    const result = await stitchImages([a, b, c], {
      direction: 'vertical', width: 100, gap: 5, background: 0xffffffff, mime: Jimp.MIME_PNG, noUpscale: true
    }, out)
    assert.equal(result.width, 100)
    assert.equal(result.height, 240)
    const img = await Jimp.read(out)
    const side = Jimp.intToRGBA(img.getPixelColor(0, 60))
    const middle = Jimp.intToRGBA(img.getPixelColor(25, 60))
    const last = Jimp.intToRGBA(img.getPixelColor(10, 160))
    assert.ok(side.r > 240 && side.g > 240 && side.b > 240, '留白为白色')
    assert.ok(middle.g > 240 && middle.r < 20, '绿色图保持原宽并居中')
    assert.ok(last.b > 240 && last.r < 20, '蓝色图保持原尺寸')

    // 不传 noUpscale 时仍放大到统一宽度
    const stretched = join(dir, 'stretch.png')
    const full = await stitchImages([a, b, c], {
      direction: 'vertical', width: 100, gap: 5, background: 0xffffffff, mime: Jimp.MIME_PNG
    }, stretched)
    assert.equal(full.height, 360)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文字水印居中与平铺', async () => {
  const stamp = solid(20, 10, 0xffffffff)
  const png = await stamp.getBufferAsync(Jimp.MIME_PNG)

  const centered = await processJimp(solid(200, 200, 0x000000ff), {
    watermark: { png, widthPercent: 20, opacity: 1, position: 'center', tile: false },
    mime: Jimp.MIME_PNG
  })
  const a = await decode(centered.data)
  const center = Jimp.intToRGBA(a.getPixelColor(100, 100))
  assert.ok(center.r > 240 && center.g > 240 && center.b > 240)

  const tiled = await processJimp(solid(200, 200, 0x000000ff), {
    watermark: { png, widthPercent: 10, opacity: 0.5, position: 'center', tile: true, gapPercent: 50 },
    mime: Jimp.MIME_PNG
  })
  const b = await decode(tiled.data)
  let bright = 0
  b.scan(0, 0, b.bitmap.width, b.bitmap.height, function (x, y, idx) {
    if (this.bitmap.data[idx] > 60) bright += 1
  })
  assert.ok(bright > 500, `平铺后应有大量水印像素,实际 ${bright}`)
})

test('拼长图超限时明确报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oot-stitch-'))
  try {
    const p = join(dir, 'big.png')
    await solid(100, 100, 0xffffffff).writeAsync(p)
    await assert.rejects(
      () => stitchImages([p, p], { direction: 'vertical', width: 20000, gap: 0 }, join(dir, 'out.png')),
      /20000|3000 万/
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
