// 常用单位换算:线性单位走 factor(统一换算到基准单位),温度单独处理
// 纯 ESM 无 import,测试可直接经 data URL 载入

export const CATEGORIES = [
  {
    id: 'length',
    label: '长度',
    units: [
      { id: 'mm', label: '毫米 mm', factor: 0.001 },
      { id: 'cm', label: '厘米 cm', factor: 0.01 },
      { id: 'm', label: '米 m', factor: 1 },
      { id: 'km', label: '千米 km', factor: 1000 },
      { id: 'in', label: '英寸 in', factor: 0.0254 },
      { id: 'ft', label: '英尺 ft', factor: 0.3048 },
      { id: 'yd', label: '码 yd', factor: 0.9144 },
      { id: 'mi', label: '英里 mi', factor: 1609.344 },
      { id: 'li', label: '里', factor: 500 },
      { id: 'chi', label: '尺', factor: 1 / 3 },
      { id: 'zhang', label: '丈', factor: 10 / 3 }
    ]
  },
  {
    id: 'area',
    label: '面积',
    units: [
      { id: 'cm2', label: '平方厘米 cm²', factor: 0.0001 },
      { id: 'm2', label: '平方米 m²', factor: 1 },
      { id: 'km2', label: '平方千米 km²', factor: 1000000 },
      { id: 'ha', label: '公顷 ha', factor: 10000 },
      { id: 'mu', label: '亩', factor: 10000 / 15 },
      { id: 'ft2', label: '平方英尺 ft²', factor: 0.09290304 }
    ]
  },
  {
    id: 'weight',
    label: '重量',
    units: [
      { id: 'g', label: '克 g', factor: 0.001 },
      { id: 'kg', label: '千克 kg', factor: 1 },
      { id: 't', label: '吨 t', factor: 1000 },
      { id: 'jin', label: '斤', factor: 0.5 },
      { id: 'liang', label: '两', factor: 0.05 },
      { id: 'lb', label: '磅 lb', factor: 0.45359237 },
      { id: 'oz', label: '盎司 oz', factor: 0.028349523125 }
    ]
  },
  {
    id: 'volume',
    label: '体积',
    units: [
      { id: 'ml', label: '毫升 mL', factor: 0.001 },
      { id: 'l', label: '升 L', factor: 1 },
      { id: 'm3', label: '立方米 m³', factor: 1000 },
      { id: 'gal_us', label: '美制加仑 gal', factor: 3.785411784 },
      { id: 'gal_uk', label: '英制加仑 gal', factor: 4.54609 }
    ]
  },
  {
    id: 'temperature',
    label: '温度',
    special: 'temperature',
    units: [
      { id: 'c', label: '摄氏度 °C' },
      { id: 'f', label: '华氏度 °F' },
      { id: 'k', label: '开尔文 K' }
    ]
  },
  {
    id: 'data',
    label: '存储',
    units: [
      { id: 'bit', label: '位 bit', factor: 0.125 },
      { id: 'b', label: '字节 B', factor: 1 },
      { id: 'kb', label: 'KB(1024)', factor: 1024 },
      { id: 'mb', label: 'MB(1024)', factor: 1024 ** 2 },
      { id: 'gb', label: 'GB(1024)', factor: 1024 ** 3 },
      { id: 'tb', label: 'TB(1024)', factor: 1024 ** 4 }
    ]
  }
]

const byId = (list, id) => list.find((item) => item.id === id) || null

function toCelsius(value, unit) {
  if (unit === 'c') return value
  if (unit === 'f') return ((value - 32) * 5) / 9
  if (unit === 'k') return value - 273.15
  return null
}

function fromCelsius(value, unit) {
  if (unit === 'c') return value
  if (unit === 'f') return (value * 9) / 5 + 32
  if (unit === 'k') return value + 273.15
  return null
}

// 返回换算结果;无效输入返回 null(界面直接显示错误)
export function convert(value, categoryId, fromId, toId) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const category = byId(CATEGORIES, categoryId)
  if (!category) return null
  const from = byId(category.units, fromId)
  const to = byId(category.units, toId)
  if (!from || !to) return null
  if (category.special === 'temperature') {
    const celsius = toCelsius(n, from.id)
    return celsius == null ? null : fromCelsius(celsius, to.id)
  }
  return (n * from.factor) / to.factor
}

// 结果格式化:最多 10 位有效数字,去掉浮点尾差;极大/极小时退回科学计数法
export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs >= 1e12 || abs < 1e-9) return value.toExponential(6).replace(/\.?0+e/, 'e')
  const text = Number(value.toPrecision(10)).toString()
  return text
}
