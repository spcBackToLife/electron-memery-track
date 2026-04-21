/**
 * Windows：GPU 引擎利用率与专用显存（C++/PDH，AsyncWorker 内采样）。
 * 外部监控时传入子树 PID，按实例名 `pid_*` 过滤，与任务管理器「进程」列口径对齐；不传 PID 时为整机参考值。
 */
import { queryGpuSystemSnapshotPdhAsync, type GpuSystemPdhSnapshot } from './native-memory'

export type GpuSystemSnapshot = GpuSystemPdhSnapshot

let lastQueryCompleteAt = 0
let inFlight = false
let cached: GpuSystemSnapshot = { engineUtilPercent: null, dedicatedUsedMB: null }
/** 与上次采样绑定的 PID 集合签名，变化则丢弃缓存 */
let cachedPidsKey = ''
/** 与采集间隔对齐，便于下一拍带上已完成的 PDH 结果 */
const CACHE_MS = 2000

function pidsCacheKey(pids: readonly number[] | undefined): string {
  if (!pids || pids.length === 0) return ''
  return [...new Set(pids.map((x) => Math.floor(Number(x))).filter((x) => x > 0))]
    .sort((a, b) => a - b)
    .join(':')
}

function applySnapshot(snap: GpuSystemSnapshot): void {
  cached = snap
  lastQueryCompleteAt = Date.now()
}

async function runPdhSampleOnce(pids: readonly number[] | undefined): Promise<void> {
  try {
    const snap =
      pids && pids.length > 0 ? await queryGpuSystemSnapshotPdhAsync(pids) : await queryGpuSystemSnapshotPdhAsync()
    applySnapshot(snap)
    if (snap.engineUtilPercent == null && snap.dedicatedUsedMB == null) {
      console.error(
        '[MonitorTool] GPU PDH 无有效读数（引擎% 与专用显存均为空）。请确认 GPU 驱动与性能计数器可用；开发环境需执行 pnpm run build:with-native 以 Electron ABI 编译 native。',
      )
    }
  } catch (e) {
    console.error('[MonitorTool] GPU 采样失败（仅 C++/PDH，无 PowerShell 回退）:', e)
    lastQueryCompleteAt = Date.now()
    cached = { engineUtilPercent: null, dedicatedUsedMB: null }
  } finally {
    inFlight = false
  }
}

/**
 * 立即返回缓存；缓存过期时在后台触发 PDH 采样，不阻塞主线程。
 * @param pids 外部监控子树 PID 列表；有值时与任务管理器进程 GPU 列同源过滤。
 */
export function queryGpuSystemSnapshotCached(pids?: readonly number[]): GpuSystemSnapshot {
  if (process.platform !== 'win32') return { engineUtilPercent: null, dedicatedUsedMB: null }

  const key = pidsCacheKey(pids)
  if (key !== cachedPidsKey) {
    cachedPidsKey = key
    lastQueryCompleteAt = 0
    cached = { engineUtilPercent: null, dedicatedUsedMB: null }
  }

  const now = Date.now()
  if (inFlight) return cached
  if (lastQueryCompleteAt > 0 && now - lastQueryCompleteAt < CACHE_MS) return cached

  inFlight = true
  void runPdhSampleOnce(pids)

  return cached
}
