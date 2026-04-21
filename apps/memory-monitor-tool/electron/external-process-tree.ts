/**
 * Windows：根据根 PID 枚举进程子树（含根），并附带进程名 / 镜像路径 / 命令行。
 * 仅使用 memory_native（Toolhelp32 + 镜像与命令行）；不再使用 PowerShell/WMI，避免把本工具起的
 * powershell.exe / conhost.exe 等与目标同父的进程误混入子树或报告。
 */
import { enumerateProcessTreeNativeSync, isNativeMemoryLoaded } from './native-memory'

export interface ProcessTreeResult {
  pids: number[]
  names: Map<number, string>
  /** Win32_Process.ExecutablePath */
  exePath: Map<number, string>
  /** Win32_Process.CommandLine */
  commandLine: Map<number, string>
}

function rowsToResult(rootPid: number, rows: NonNullable<ReturnType<typeof enumerateProcessTreeNativeSync>>): ProcessTreeResult {
  const pids: number[] = []
  const names = new Map<number, string>()
  const exePath = new Map<number, string>()
  const commandLine = new Map<number, string>()
  for (const r of rows) {
    pids.push(r.pid)
    names.set(r.pid, r.name.trim() ? r.name : `PID ${r.pid}`)
    if (r.exePath.trim()) exePath.set(r.pid, r.exePath.trim())
    if (r.commandLine.trim()) commandLine.set(r.pid, r.commandLine.trim())
  }
  return { pids, names, exePath, commandLine }
}

/**
 * 异步包装仅为与 main 里既有 `void fetchWindowsProcessTree().then(...)` 兼容；实现上仅同步 Native。
 * 无 native 或枚举失败时只返回根 PID 占位（不启动 PowerShell）。
 */
export function fetchWindowsProcessTree(rootPid: number): Promise<ProcessTreeResult> {
  if (process.platform !== 'win32' || !Number.isFinite(rootPid) || rootPid <= 0) {
    return Promise.resolve({ pids: [], names: new Map(), exePath: new Map(), commandLine: new Map() })
  }

  const root = Math.floor(rootPid)
  const emptyFallback: ProcessTreeResult = {
    pids: [root],
    names: new Map([[root, `PID ${root}`]]),
    exePath: new Map(),
    commandLine: new Map(),
  }

  if (!isNativeMemoryLoaded()) {
    console.warn(
      '[external-process-tree] memory_native 未加载，无法枚举外部子树（已禁用 PowerShell 回退）。请 build:with-native 后重试。',
    )
    return Promise.resolve(emptyFallback)
  }

  try {
    const rows = enumerateProcessTreeNativeSync(root)
    if (rows != null && rows.length > 0) {
      return Promise.resolve(rowsToResult(root, rows))
    }
  } catch (e) {
    console.warn('[external-process-tree] native enumerate failed:', e)
  }

  return Promise.resolve(emptyFallback)
}
