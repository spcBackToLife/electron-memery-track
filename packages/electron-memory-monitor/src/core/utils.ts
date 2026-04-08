/**
 * 工具函数
 */

/** 简单的 UUID v4 生成（不依赖外部库） */
export function v4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 格式化字节数 */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k))
  const idx = Math.min(i, sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(2)) + ' ' + sizes[idx]
}

/** KB 转换为 bytes */
export function kbToBytes(kb: number): number {
  return kb * 1024
}

/** bytes 转换为 KB */
export function bytesToKb(bytes: number): number {
  return bytes / 1024
}

/** bytes 转换为 MB */
export function bytesToMb(bytes: number): number {
  return bytes / (1024 * 1024)
}

/** 计算数组的百分位数 */
export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(idx)
  const upper = Math.ceil(idx)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower)
}

/** 计算平均值 */
export function average(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

/** 线性回归 */
export function linearRegression(values: number[], timestamps: number[]): { slope: number; r2: number; intercept: number } {
  const n = values.length
  if (n < 2) return { slope: 0, r2: 0, intercept: values[0] || 0 }

  // 标准化时间戳（秒）
  const t0 = timestamps[0]
  const xs = timestamps.map((t) => (t - t0) / 1000)

  const sumX = xs.reduce((a, b) => a + b, 0)
  const sumY = values.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((sum, x, i) => sum + x * values[i], 0)
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0)
  const sumY2 = values.reduce((sum, y) => sum + y * y, 0)

  const denominator = n * sumX2 - sumX * sumX
  if (denominator === 0) return { slope: 0, r2: 0, intercept: sumY / n }

  const slope = (n * sumXY - sumX * sumY) / denominator
  const intercept = (sumY - slope * sumX) / n

  // R² 拟合优度
  const meanY = sumY / n
  const ssTotal = sumY2 - n * meanY * meanY
  const ssResidual = values.reduce((sum, y, i) => {
    const predicted = intercept + slope * xs[i]
    return sum + (y - predicted) ** 2
  }, 0)

  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal

  return { slope, r2, intercept }
}
