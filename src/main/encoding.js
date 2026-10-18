const iconv = require('iconv-lite')
const { TextDecoder } = require('util')

const ENCODINGS = {
  utf8: 'utf8',
  utf8bom: 'utf8',
  gbk: 'gbk',
  gb18030: 'gb18030',
  utf16le: 'utf16-le',
  utf16be: 'utf16-be'
}

// 检测顺序:BOM → 严格 UTF-8 → GB18030。GBK 是 GB18030 子集,统一按 GB18030 解码。
const utf8Fatal = new TextDecoder('utf-8', { fatal: true })

function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le'
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be'
  try {
    utf8Fatal.decode(buf)
    return 'utf8'
  } catch {
    return 'gb18030'
  }
}

function decodeText(data, encoding) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const requested = encoding === 'auto' ? detectEncoding(buf) : encoding
  const used = ENCODINGS[requested] ? requested : 'utf8'
  const text = iconv.decode(buf, ENCODINGS[used]).replace(/^\uFEFF/, '')
  return { text, encoding: used }
}

function encodeText(text, encoding) {
  const name = ENCODINGS[encoding] || 'utf8'
  // iconv-lite 的 writeBOM 对 utf8 不生效,BOM 自己拼
  const body = encoding === 'utf8bom' ? '\uFEFF' + text : text
  return iconv.encode(body, name)
}

module.exports = { ENCODINGS, detectEncoding, decodeText, encodeText }
