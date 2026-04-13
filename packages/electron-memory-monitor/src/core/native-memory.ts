/**
 * native-memory.ts — 原生内存采集模块的 TypeScript 包装层
 *
 * 尝试加载 C++ 原生模块来获取 Windows 进程专用工作集。
 * 如果原生模块不可用（未编译、非 Windows、或加载失败），
 * 自动 fallback 到 PowerShell/WMI 方案。
 *
 * 对外暴露统一接口，collector.ts 不需要关心底层实现。
 */

import { execFile } from 'child_process'
import * as path from 'path'

const IS_WINDOWS = process.platform === 'win32'

// ─── Native module interface ────────────────────────────────────

interface NativeMemoryDetails {
  /** Working set size (bytes) */
  workingSetSize: number
  /** Peak working set (bytes) */
  peakWorkingSetSize: number
  /** Private bytes / committed (bytes) */
  privateUsage: number
  /** Pagefile usage (bytes) */
  pagefileUsage: number
}

interface NativeMemoryModule {
  getProcessMemoryDetails(pid: number): NativeMemoryDetails | null
  getPrivateWorkingSet(pid: number): number
  batchGetPrivateWorkingSet(pids: number[]): Record<string, number>
  batchGetProcessMemory(pids: number[]): Record<string, NativeMemoryDetails>
}

// ─── Load native module ──────────────────────────────────

let nativeModule: NativeMemoryModule | null = null
let nativeLoadError: string | null = null

function tryLoadNative(): NativeMemoryModule | null {
  if (!IS_WINDOWS) return null

  // Build search paths based on __dirname at runtime:
  //   - When running from SDK dist: __dirname = .../node_modules/@electron-memory/monitor/dist
  //     => .node at ../native/build/Release/ or ../native/
  //   - When running from source (development): __dirname = .../src/core
  //     => .node at ../../native/build/Release/
  const possiblePaths = [
    // Published SDK: dist/native/memory_native.node (copied during build)
    path.join(__dirname, 'native', 'memory_native.node'),
    // Published SDK alternative: native/build/Release/
    path.join(__dirname, '..', 'native', 'build', 'Release', 'memory_native.node'),
    // Development (source): ../../native/build/Release/
    path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'memory_native.node'),
  ]

  for (const p of possiblePaths) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(p) as NativeMemoryModule
      if (typeof mod.batchGetPrivateWorkingSet === 'function') {
        console.log(`[MemoryMonitor] Native module loaded from: ${p}`)
        return mod
      }
    } catch {
      // Try next path
    }
  }

  return null
}

try {
  nativeModule = tryLoadNative()
  if (nativeModule) {
    console.log('[MemoryMonitor] Native memory module loaded successfully')
  } else if (IS_WINDOWS) {
    nativeLoadError = 'Native module not found, falling back to PowerShell/WMI'
    console.warn(`[MemoryMonitor] ${nativeLoadError}`)
  }
} catch (e) {
  nativeLoadError = String(e)
  console.warn(`[MemoryMonitor] Failed to load native module: ${nativeLoadError}`)
}

// ─── PowerShell Fallback ───────────────────────────────

function queryPrivateWorkingSetPowerShell(pids: number[]): Promise<Map<number, number>> {
  if (!IS_WINDOWS || pids.length === 0) return Promise.resolve(new Map())

  return new Promise((resolve) => {
    const pidFilter = pids.join(',')
    const wmiScript = `Get-CimInstance Win32_Process -Filter "ProcessId IN (${pidFilter})" -Property ProcessId,WorkingSetPrivate -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId),$([Math]::Floor($_.WorkingSetPrivate / 1024))" }`

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-Command', wmiScript],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(new Map())
          return
        }
        const map = new Map<number, number>()
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          const parts = line.trim().split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[0], 10)
            const kb = parseInt(parts[1], 10)
            if (!isNaN(pid) && !isNaN(kb)) {
              map.set(pid, kb)
            }
          }
        }
        resolve(map)
      },
    )
  })
}

// ─── 统一对外接口 ──────────────────────────────────────

export interface PrivateWorkingSetProvider {
  /** 当前使用的后端类型 */
  readonly backend: 'native' | 'powershell' | 'none'
  /** 批量查询专用工作集，返回 PID → KB 映射 */
  queryPrivateWorkingSet(pids: number[]): Promise<Map<number, number>>
  /** 是否可用 */
  readonly available: boolean
}

/**
 * 创建专用工作集查询 Provider。
 * 优先使用 C++ 原生模块，不可用时 fallback 到 PowerShell。
 */
export function createPrivateWsProvider(): PrivateWorkingSetProvider {
  if (nativeModule) {
    const mod = nativeModule
    return {
      backend: 'native',
      available: true,
      queryPrivateWorkingSet: async (pids: number[]) => {
        if (pids.length === 0) return new Map()
        try {
          // 原生模块是同步调用，直接返回结果
          const result = mod.batchGetPrivateWorkingSet(pids)
          const map = new Map<number, number>()
          for (const [pidStr, bytes] of Object.entries(result)) {
            const pid = parseInt(pidStr, 10)
            if (!isNaN(pid) && bytes >= 0) {
              // 原生模块返回 bytes，转成 KB
              map.set(pid, Math.floor(bytes / 1024))
            }
          }
          return map
        } catch {
          return new Map()
        }
      },
    }
  }

  if (IS_WINDOWS) {
    return {
      backend: 'powershell',
      available: true,
      queryPrivateWorkingSet: queryPrivateWorkingSetPowerShell,
    }
  }

  return {
    backend: 'none',
    available: false,
    queryPrivateWorkingSet: async () => new Map(),
  }
}

/** 获取原生模块加载状态信息（用于调试/UI 展示） */
export function getNativeModuleStatus(): {
  loaded: boolean
  backend: string
  error: string | null
} {
  return {
    loaded: nativeModule !== null,
    backend: nativeModule ? 'native (C++)' : IS_WINDOWS ? 'powershell (fallback)' : 'none',
    error: nativeLoadError,
  }
}
