// 只压缩普通 8 位 DeviceRGB/DeviceGray 位图;其余色彩空间与带 Decode/DecodeParms/Mask 的流跳过。
// 这些参数(如 predictor、颜色反转、色键遮罩)不解码就会产出错误像素,宁可不压。
export function isCompressibleImage(info) {
  if (!info.width || !info.height) return false
  if (info.colorSpace !== '/DeviceRGB' && info.colorSpace !== '/DeviceGray') return false
  if (info.bits != null && info.bits !== 8) return false
  if (info.hasDecodeParms || info.hasDecode || info.hasMask) return false
  if (info.imageMask) return false
  return true
}
