/**
 * 实时趋势图：限制折线点数，减轻 Recharts 与主线程压力（磁盘仍存全量快照）。
 */
export function downsampleUniform<T>(arr: T[], maxLen: number): T[] {
  if (arr.length <= maxLen || maxLen < 2) return arr
  const n = arr.length
  const out: T[] = []
  let lastIdx = -1
  for (let i = 0; i < maxLen; i++) {
    const idx = Math.min(n - 1, Math.round((i * (n - 1)) / (maxLen - 1)))
    if (idx !== lastIdx) {
      out.push(arr[idx]!)
      lastIdx = idx
    }
  }
  if (out[out.length - 1] !== arr[n - 1]) {
    out.push(arr[n - 1]!)
  }
  return out
}
