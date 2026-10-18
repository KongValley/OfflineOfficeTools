const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const UNITS = ['', '拾', '佰', '仟']
const GROUPS = ['', '万', '亿', '万亿']

// 整数(十进制字符串)→ 财务大写;按位从高到低,零连续压缩为一个「零」
function intToChinese(numStr) {
  const digits = String(numStr).replace(/^0+/, '')
  if (!digits) return ''
  const n = digits.length
  let out = ''
  let pendingZero = false
  for (let pos = n - 1; pos >= 0; pos -= 1) {
    const d = Number(digits[n - 1 - pos])
    if (d === 0) {
      pendingZero = out.length > 0
      continue
    }
    if (pendingZero) {
      out += '零'
      pendingZero = false
    }
    out += DIGITS[d] + UNITS[pos % 4] + GROUPS[Math.floor(pos / 4)]
  }
  return out
}

// 金额 → 人民币大写;第三位小数四舍五入进位到元;非法返回 null
export function amountToChinese(input) {
  const raw = String(input).trim().replace(/,/g, '').replace(/[¥￥]/g, '').replace(/元/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null
  const neg = raw.startsWith('-')
  const abs = neg ? raw.slice(1) : raw
  const [ip, fp = ''] = abs.split('.')
  const fp3 = (fp + '000').slice(0, 3)
  let cents = Math.round(Number(fp3) / 10)
  let yuan = BigInt(ip)
  if (cents === 100) {
    yuan += 1n
    cents = 0
  }
  const jiao = Math.floor(cents / 10)
  const fen = cents % 10
  let out = (intToChinese(yuan.toString()) || '零') + '元'
  if (cents === 0) out += '整'
  else if (jiao > 0) out += DIGITS[jiao] + '角' + (fen > 0 ? DIGITS[fen] + '分' : '')
  else out += '零' + DIGITS[fen] + '分'
  return (neg ? '负' : '') + out
}
