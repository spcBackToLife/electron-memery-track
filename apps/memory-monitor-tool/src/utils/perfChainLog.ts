/**
 * 渲染进程诊断：控制台 + 主进程写入 userData/mmt-diag.log（与 [MMT:diag][main] 同文件）
 */
export function perfChainRenderer(tag: string, data?: Record<string, unknown>): void {
  const perfMs = typeof performance !== 'undefined' ? performance.now() : 0
  const record: Record<string, unknown> = { tag, t: Date.now(), perfMs: Number(perfMs.toFixed(1)), ...data }
  console.log(`[MMT:diag][renderer] ${tag}`, record)
  try {
    window.monitorAPI.diagAppend(record)
  } catch {
    /* 忽略 */
  }
}
