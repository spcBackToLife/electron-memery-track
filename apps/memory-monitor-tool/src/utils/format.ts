/**
 * 工具函数 - 格式化与计算
 */

/**
 * 获取有效内存值 (KB)，优先 privateWorkingSet，回退 workingSetSize
 */
export function getEffectiveMemoryKB(mem: {
  workingSetSize: number
  privateWorkingSet?: number
}): number {
  return mem.privateWorkingSet ?? mem.workingSetSize
}

/** 格式化 KB 为可读字符串 */
export function formatKB(kb: number | undefined | null): string {
  if (kb == null || isNaN(kb)) return '0 KB'
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

/** 格式化 Bytes */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 格式化时间戳 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

/** 会话下拉等：日期 + 时分秒（本地时区） */
export function formatSessionSelectLabel(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  const h = d.getHours().toString().padStart(2, '0')
  const mi = d.getMinutes().toString().padStart(2, '0')
  const s = d.getSeconds().toString().padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${mi}:${s}`
}

/** 格式化时长 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}h ${m}m`
}
