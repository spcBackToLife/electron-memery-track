/**
 * native-memory.ts — 原生内存采集模块（Monitor Tool 独立版本）
 *
 * 加载 C++ 原生模块获取 Windows 进程专用工作集 (WorkingSetPrivate)。
 * 不可用时自动 fallback 到 PowerShell/WMI。
 *
 * 与 SDK 版本的区别：
 *   - 搜索路径适配独立应用目录结构
 *   - __dirname 在打包后指向 dist-electron/
 */

import { execFile } from 'child_process'
import * as path from 'path'

const IS_WINDOWS = process.platform === 'win32'

interface NativeMemoryModule {
  getProcessMemoryDetails(pid: number): { workingSetSize: number; peakWorkingSetSize: number; privateUsage: number; pagefileUsage: number } | null
  getPrivateWorkingSet(pid: number): number
  batchGetPrivateWorkingSet(pids: number[]): Record<string, number>
  batchGetProcessMemory(pids: number[]): Record<string, unknown>
}

let nativeModule: NativeMemoryModule | null = null
let nativeLoadError: string | null = null

function tryLoadNative(): NativeMemoryModule | null {
  if (!IS_WINDOWS) return null

  // Monitor Tool 的 .node 文件搜索路径：
  // 开发模式: dist-electron/ → ../native/build/Release/memory_native.node
  // 打包后: dist-electron/ → ../../native/... 或通过 extraResources
  const possiblePaths = [
    // 打包后：native/ 目录被 asarUnpack 到 app.asar.unpacked/native/
    path.join(__dirname, '..', 'native', 'memory_native.node'),
    // 开发模式：项目根目录下的 native/build/Release/
    path.join(__dirname, '..', 'native', 'build', 'Release', 'memory_native.node'),
    // 再上一级的开发路径
    path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'memory_native.node'),
  ]

  for (const p of possiblePaths) {
    try {
      const mod = require(p) as NativeMemoryModule
      if (typeof mod.batchGetPrivateWorkingSet === 'function') {
        console.log(`[MonitorTool] Native module loaded from: ${p}`)
        return mod
      }
    } catch {
      // 继续尝试下一个路径
    }
  }

  return null
}

try {
  nativeModule = tryLoadNative()
  if (nativeModule) {
    console.log('[MonitorTool] Native memory module loaded successfully')
  } else if (IS_WINDOWS) {
    nativeLoadError = 'Native module not found, falling back to PowerShell/WMI'
    console.warn(`[MonitorTool] ${nativeLoadError}`)
  }
} catch (e) {
  nativeLoadError = String(e)
  console.warn(`[MonitorTool] Failed to load native module: ${nativeLoadError}`)
}

const PS_EXEC_OPTIONS: { maxBuffer: number } = { maxBuffer: 16 * 1024 * 1024 }

function psStdoutToUtf8(stdout: string | Buffer | undefined | null): string {
  if (stdout == null) return ''
  if (Buffer.isBuffer(stdout)) return stdout.toString('utf8')
  return String(stdout)
}

function queryPrivateWorkingSetPowerShell(pids: number[]): Promise<Map<number, number>> {
  if (!IS_WINDOWS || pids.length === 0) return Promise.resolve(new Map())

  return new Promise((resolve) => {
    const pidFilter = pids.join(',')
    const wmiScript = `Get-CimInstance Win32_Process -Filter "ProcessId IN (${pidFilter})" -Property ProcessId,WorkingSetPrivate -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId),$([Math]::Floor($_.WorkingSetPrivate / 1024))" }`

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-Command', wmiScript],
      { ...PS_EXEC_OPTIONS, timeout: 8000 },
      (err, stdout) => {
        if (err) { resolve(new Map()); return }
        const map = new Map<number, number>()
        const text = psStdoutToUtf8(stdout)
        const lines = text.trim().split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          const parts = line.trim().split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[0], 10)
            const kb = parseInt(parts[1], 10)
            if (!isNaN(pid) && !isNaN(kb)) map.set(pid, kb)
          }
        }
        resolve(map)
      },
    )
  })
}

/** 外部 exe 进程树：仅用 memory_native（C++）同步读数，与 batchGetPrivateWorkingSet / batchGetProcessMemory 一致 */
export interface ExternalNativeMemoryRow {
  privateKb: number
  workingSetKb: number
  peakKb: number
}

export function isNativeMemoryLoaded(): boolean {
  return nativeModule !== null
}

/**
 * 同步调用 C++ addon：专用工作集（QueryWorkingSetEx）+ 工作集/峰值（GetProcessMemoryInfo）。
 * 未加载 native 时返回空 Map（由主进程决定是否仍展示外部树）。
 */
export function readExternalProcessMemoryNativeSync(pids: number[]): Map<number, ExternalNativeMemoryRow> {
  const map = new Map<number, ExternalNativeMemoryRow>()
  if (!nativeModule || !IS_WINDOWS || pids.length === 0) return map

  const uniq = [...new Set(pids)].filter((n) => Number.isFinite(n) && n > 0)
  if (uniq.length === 0) return map

  try {
    const privObj = nativeModule.batchGetPrivateWorkingSet(uniq)
    const detailObj = nativeModule.batchGetProcessMemory(uniq) as Record<string, Record<string, number>>
    for (const pid of uniq) {
      const key = String(pid)
      const bytes = privObj[key] as number | undefined
      const privKb = bytes != null && bytes >= 0 ? Math.floor(bytes / 1024) : 0
      const o = detailObj[key]
      const wsKb = o ? Math.max(0, Math.floor((o.workingSetSize ?? 0) / 1024)) : 0
      const peakKb = o ? Math.max(0, Math.floor((o.peakWorkingSetSize ?? 0) / 1024)) : wsKb
      map.set(pid, {
        privateKb: privKb > 0 ? privKb : wsKb,
        workingSetKb: wsKb,
        peakKb: peakKb > 0 ? peakKb : wsKb,
      })
    }
  } catch (e) {
    console.warn('[MonitorTool] readExternalProcessMemoryNativeSync failed:', e)
  }
  return map
}

export interface PrivateWorkingSetProvider {
  readonly backend: 'native' | 'powershell' | 'none'
  queryPrivateWorkingSet(pids: number[]): Promise<Map<number, number>>
  readonly available: boolean
}

export function createPrivateWsProvider(): PrivateWorkingSetProvider {
  if (nativeModule) {
    const mod = nativeModule
    return {
      backend: 'native',
      available: true,
      queryPrivateWorkingSet: async (pids: number[]) => {
        if (pids.length === 0) return new Map()
        try {
          const result = mod.batchGetPrivateWorkingSet(pids)
          const map = new Map<number, number>()
          for (const [pidStr, bytes] of Object.entries(result)) {
            const pid = parseInt(pidStr, 10)
            if (!isNaN(pid) && bytes >= 0) map.set(pid, Math.floor(bytes / 1024))
          }
          return map
        } catch {
          return new Map()
        }
      },
    }
  }

  if (IS_WINDOWS) {
    return { backend: 'powershell', available: true, queryPrivateWorkingSet: queryPrivateWorkingSetPowerShell }
  }

  return { backend: 'none', available: false, queryPrivateWorkingSet: async () => new Map() }
}

export function getNativeModuleStatus(): { loaded: boolean; backend: string; error: string | null } {
  return {
    loaded: nativeModule !== null,
    backend: nativeModule ? 'native (C++)' : IS_WINDOWS ? 'powershell (fallback)' : 'none',
    error: nativeLoadError,
  }
}

/** 工作集 / 峰值 等（KB），仅 Windows 且 native 可用时有效 */
export function batchGetProcessMemoryKb(pids: number[]): Map<number, { workingSetSize: number; peakWorkingSetSize: number }> {
  const out = new Map<number, { workingSetSize: number; peakWorkingSetSize: number }>()
  if (!nativeModule || pids.length === 0) return out
  try {
    const raw = nativeModule.batchGetProcessMemory(pids) as Record<string, Record<string, number>>
    for (const [pidStr, o] of Object.entries(raw)) {
      const pid = parseInt(pidStr, 10)
      if (isNaN(pid) || !o) continue
      const ws = Math.max(0, Math.floor((o.workingSetSize ?? 0) / 1024))
      const peak = Math.max(0, Math.floor((o.peakWorkingSetSize ?? 0) / 1024))
      out.set(pid, { workingSetSize: ws, peakWorkingSetSize: peak })
    }
  } catch {
    /* ignore */
  }
  return out
}
