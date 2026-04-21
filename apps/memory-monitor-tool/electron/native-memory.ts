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
import { app } from 'electron'
import * as path from 'path'

const IS_WINDOWS = process.platform === 'win32'

interface NativeMemoryModule {
  getProcessMemoryDetails(pid: number): { workingSetSize: number; peakWorkingSetSize: number; privateUsage: number; pagefileUsage: number } | null
  getPrivateWorkingSet(pid: number): number
  batchGetPrivateWorkingSet(pids: number[]): Record<string, number>
  batchGetProcessMemory(pids: number[]): Record<string, unknown>
  /** Windows：Toolhelp32 + QueryFullProcessImageName + NtQueryInformationProcess */
  enumerateProcessTree?(rootPid: number): unknown
  gatherExternalMonitorSnapshotAsync?(rootPid: number): Promise<unknown>
  /** Windows：GetProcessTimes + GetProcessIoCounters（原始累计值，主进程算间隔） */
  batchGetProcessTimesAndIo?(pids: number[]): Record<string, unknown>
  /** Windows：PDH 异步采样 GPU（可选子树 PID 过滤） */
  /** 可选参数：外部子树 PID 数组；传入时按 PID 过滤 PDH 实例（与任务管理器进程列更一致） */
  queryGpuSystemSnapshotAsync?(pids?: number[]): Promise<unknown>
}

let nativeModule: NativeMemoryModule | null = null
let nativeLoadError: string | null = null

function tryLoadNative(): NativeMemoryModule | null {
  if (!IS_WINDOWS) return null

  // Monitor Tool 的 .node 文件搜索路径：
  // 打包后：electron-builder + asarUnpack 时 .node 在 resources/app.asar.unpacked/native/（与 app.asar 内 main 不同目录）
  // 开发：dist-electron/ → ../native/build/Release/ 或 ../native/memory_native.node
  const possiblePaths: string[] = []
  try {
    if (app.isPackaged) {
      possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'memory_native.node'))
    }
  } catch {
    /* 非 Electron 上下文 */
  }
  possiblePaths.push(
    path.join(__dirname, '..', 'native', 'memory_native.node'),
    path.join(__dirname, '..', 'native', 'build', 'Release', 'memory_native.node'),
    path.join(__dirname, '..', '..', 'native', 'build', 'Release', 'memory_native.node'),
  )

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

export interface ProcessTimesIoRow {
  userTime100ns: number
  kernelTime100ns: number
  readBytes: number
  writeBytes: number
}

/** 同步读取各 PID 的 CPU 时间片与磁盘累计 IO；未加载 native 或无导出时返回空 Map */
export function batchGetProcessTimesAndIoSync(pids: number[]): Map<number, ProcessTimesIoRow> {
  const out = new Map<number, ProcessTimesIoRow>()
  if (!nativeModule || !IS_WINDOWS || pids.length === 0) return out
  const mod = nativeModule
  if (typeof mod.batchGetProcessTimesAndIo !== 'function') return out
  const uniq = [...new Set(pids)].filter((n) => Number.isFinite(n) && n > 0)
  if (uniq.length === 0) return out
  try {
    const raw = mod.batchGetProcessTimesAndIo(uniq) as Record<string, Record<string, unknown>>
    for (const [pidStr, row] of Object.entries(raw)) {
      const pid = parseInt(pidStr, 10)
      if (Number.isNaN(pid) || !row || typeof row !== 'object') continue
      const u = Number(row.userTime100ns)
      const k = Number(row.kernelTime100ns)
      const r = Number(row.readBytes)
      const w = Number(row.writeBytes)
      if (!Number.isFinite(u) || !Number.isFinite(k)) continue
      out.set(pid, {
        userTime100ns: u,
        kernelTime100ns: k,
        readBytes: Number.isFinite(r) ? r : 0,
        writeBytes: Number.isFinite(w) ? w : 0,
      })
    }
  } catch (e) {
    console.warn('[MonitorTool] batchGetProcessTimesAndIoSync failed:', e)
  }
  return out
}

/** C++ 枚举的根进程子树（Toolhelp32 + NtQueryInformationProcess） */
export interface NativeProcessTreeRow {
  pid: number
  /** 单次快照中的父进程 ID；用于剔除误混入的兄弟进程（如监控工具自身起的 powershell） */
  parentPid?: number
  name: string
  exePath: string
  commandLine: string
}

/** gatherExternalMonitorSnapshotAsync 解析后的结果（与主进程 assemble 外部快照一致） */
export interface ExternalGatheredSnapshotPayload {
  tree: NativeProcessTreeRow[]
  memory: Map<number, ExternalNativeMemoryRow>
  timesIo: Map<number, ProcessTimesIoRow>
}

/**
 * 仅保留「从该 PID 沿父链能走回到 rootPid」的节点（含根）。
 * 旧版 .node 无 parentPid 时原样返回。
 */
export function filterProcessTreeRowsStrictDescendants(
  rootPid: number,
  rows: NativeProcessTreeRow[],
): NativeProcessTreeRow[] {
  if (rows.length <= 1) return rows
  const parents = new Map<number, number>()
  for (const r of rows) {
    const pp = r.parentPid
    if (typeof pp === 'number' && Number.isFinite(pp) && pp > 0) parents.set(r.pid, Math.floor(pp))
  }
  if (parents.size === 0) return rows

  const under = (pid: number): boolean => {
    const seen = new Set<number>()
    let cur = pid
    for (let i = 0; i < 4096; i++) {
      if (cur === rootPid) return true
      if (seen.has(cur)) return false
      seen.add(cur)
      const next = parents.get(cur)
      if (next == null || next <= 0) return false
      cur = next
    }
    return false
  }

  const kept = rows.filter((r) => r.pid === rootPid || under(r.pid))
  return kept.length > 0 ? kept : rows
}

/**
 * 同步：用 memory_native 走系统 API 枚举子树（镜像路径、命令行），不调用 PowerShell。
 * 未加载 native、导出不存在或调用失败时返回 null。
 */
export function enumerateProcessTreeNativeSync(rootPid: number): NativeProcessTreeRow[] | null {
  if (!nativeModule || !IS_WINDOWS || !Number.isFinite(rootPid) || rootPid <= 0) return null
  const mod = nativeModule
  if (typeof mod.enumerateProcessTree !== 'function') return null
  const root = Math.floor(rootPid)
  try {
    const raw = mod.enumerateProcessTree(root) as unknown
    if (!Array.isArray(raw) || raw.length === 0) return null
    const out: NativeProcessTreeRow[] = []
    for (const item of raw) {
      if (item == null || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const pid = typeof o.pid === 'number' ? o.pid : Number(o.pid)
      if (!Number.isFinite(pid) || pid <= 0) continue
      const ppRaw = o.parentPid
      const parentPid =
        typeof ppRaw === 'number'
          ? Math.floor(ppRaw)
          : typeof ppRaw === 'string' && ppRaw.trim() !== ''
            ? Math.floor(Number(ppRaw))
            : undefined
      out.push({
        pid: Math.floor(pid),
        parentPid: typeof parentPid === 'number' && Number.isFinite(parentPid) && parentPid >= 0 ? parentPid : undefined,
        name: typeof o.name === 'string' ? o.name : '',
        exePath: typeof o.exePath === 'string' ? o.exePath : '',
        commandLine: typeof o.commandLine === 'string' ? o.commandLine : '',
      })
    }
    if (out.length === 0) return null
    const filtered = filterProcessTreeRowsStrictDescendants(root, out)
    return filtered.length > 0 ? filtered : null
  } catch (e) {
    console.warn('[MonitorTool] enumerateProcessTreeNativeSync failed:', e)
    return null
  }
}

/**
 * 在 Native AsyncWorker（libuv 线程池）中完成子树枚举 + 每 PID 内存与 Times/IO，避免阻塞主线程。
 * 旧版 .node 无导出时返回 null。
 */
export async function gatherExternalMonitorSnapshotAsync(
  rootPid: number,
): Promise<ExternalGatheredSnapshotPayload | null> {
  const mod = nativeModule
  if (!mod || !IS_WINDOWS || !Number.isFinite(rootPid) || rootPid <= 0) return null
  if (typeof mod.gatherExternalMonitorSnapshotAsync !== 'function') return null
  try {
    const raw = await mod.gatherExternalMonitorSnapshotAsync(Math.floor(rootPid))
    if (raw == null || typeof raw !== 'object') return null
    const root = raw as Record<string, unknown>
    const treeRaw = root.tree
    if (!Array.isArray(treeRaw) || treeRaw.length === 0) return null

    const tree: NativeProcessTreeRow[] = []
    for (const item of treeRaw) {
      if (item == null || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const pid = typeof o.pid === 'number' ? o.pid : Number(o.pid)
      if (!Number.isFinite(pid) || pid <= 0) continue
      const ppRaw = o.parentPid
      const parentPid =
        typeof ppRaw === 'number'
          ? Math.floor(ppRaw)
          : typeof ppRaw === 'string' && ppRaw.trim() !== ''
            ? Math.floor(Number(ppRaw))
            : undefined
      tree.push({
        pid: Math.floor(pid),
        parentPid: typeof parentPid === 'number' && Number.isFinite(parentPid) && parentPid >= 0 ? parentPid : undefined,
        name: typeof o.name === 'string' ? o.name : '',
        exePath: typeof o.exePath === 'string' ? o.exePath : '',
        commandLine: typeof o.commandLine === 'string' ? o.commandLine : '',
      })
    }
    if (tree.length === 0) return null

    const rootNorm = Math.floor(rootPid)
    const treeFiltered = filterProcessTreeRowsStrictDescendants(rootNorm, tree)
    const treeOut = treeFiltered.length > 0 ? treeFiltered : tree

    const memoryAll = new Map<number, ExternalNativeMemoryRow>()
    const memObj = root.memory
    if (memObj && typeof memObj === 'object') {
      for (const [pidStr, v] of Object.entries(memObj as Record<string, unknown>)) {
        const pid = parseInt(pidStr, 10)
        if (Number.isNaN(pid)) continue
        if (v == null || typeof v !== 'object') continue
        const m = v as Record<string, unknown>
        const privKb = Number(m.privateKb)
        const wsKb = Number(m.workingSetKb)
        const peakKb = Number(m.peakKb)
        memoryAll.set(pid, {
          privateKb: Number.isFinite(privKb) ? privKb : 0,
          workingSetKb: Number.isFinite(wsKb) ? wsKb : 0,
          peakKb: Number.isFinite(peakKb) ? peakKb : Number.isFinite(wsKb) ? wsKb : 0,
        })
      }
    }

    const timesIoAll = new Map<number, ProcessTimesIoRow>()
    const tObj = root.timesIo
    if (tObj && typeof tObj === 'object') {
      for (const [pidStr, row] of Object.entries(tObj as Record<string, unknown>)) {
        const pid = parseInt(pidStr, 10)
        if (Number.isNaN(pid) || row == null || typeof row !== 'object') continue
        const r = row as Record<string, unknown>
        const u = Number(r.userTime100ns)
        const k = Number(r.kernelTime100ns)
        const rb = Number(r.readBytes)
        const wb = Number(r.writeBytes)
        if (!Number.isFinite(u) || !Number.isFinite(k)) continue
        timesIoAll.set(pid, {
          userTime100ns: u,
          kernelTime100ns: k,
          readBytes: Number.isFinite(rb) ? rb : 0,
          writeBytes: Number.isFinite(wb) ? wb : 0,
        })
      }
    }

    const memory = new Map<number, ExternalNativeMemoryRow>()
    const timesIo = new Map<number, ProcessTimesIoRow>()
    for (const r of treeOut) {
      const mem = memoryAll.get(r.pid)
      if (mem) memory.set(r.pid, mem)
      const t = timesIoAll.get(r.pid)
      if (t) timesIo.set(r.pid, t)
    }

    return { tree: treeOut, memory, timesIo }
  } catch (e) {
    console.warn('[MonitorTool] gatherExternalMonitorSnapshotAsync failed:', e)
    return null
  }
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
    backend: nativeModule ? 'native (C++)' : IS_WINDOWS ? 'no native (build:with-native)' : 'none',
    error: nativeLoadError,
  }
}

/** 与 external-gpu-metrics 中 GpuSystemSnapshot 字段一致 */
export interface GpuSystemPdhSnapshot {
  engineUtilPercent: number | null
  dedicatedUsedMB: number | null
}

function parseGpuSystemSnapshotFromNative(raw: unknown): GpuSystemPdhSnapshot {
  if (raw == null || typeof raw !== 'object') return { engineUtilPercent: null, dedicatedUsedMB: null }
  const o = raw as Record<string, unknown>
  const utilRaw = o.engineUtilPercent
  const memRaw = o.dedicatedUsedMB
  const engineUtilPercent =
    typeof utilRaw === 'number' && Number.isFinite(utilRaw) ? Math.round(utilRaw * 10) / 10 : null
  const dedicatedUsedMB =
    typeof memRaw === 'number' && Number.isFinite(memRaw) && memRaw >= 0 ? Math.round(memRaw * 10) / 10 : null
  return { engineUtilPercent, dedicatedUsedMB }
}

/**
 * 通过 C++/PDH 异步采样 GPU（不阻塞主线程）。
 * 传入 `pids` 时按子树 PID 过滤 `GPU Engine` / `GPU Process Memory` 实例；不传则为整机视角。
 * Windows 上若未加载 native 或无导出则抛错（便于主进程打日志）；非 Windows 返回空指标。
 */
export async function queryGpuSystemSnapshotPdhAsync(pids?: readonly number[]): Promise<GpuSystemPdhSnapshot> {
  if (!IS_WINDOWS) return { engineUtilPercent: null, dedicatedUsedMB: null }
  if (!nativeModule) {
    throw new Error(
      'memory_native 未加载。请在 apps/memory-monitor-tool 下执行 pnpm run build:with-native（须与当前 Electron 版本一致），再启动应用。',
    )
  }
  const fn = nativeModule.queryGpuSystemSnapshotAsync
  if (typeof fn !== 'function') {
    throw new Error(
      'memory_native 未导出 queryGpuSystemSnapshotAsync。请重新执行 pnpm run build:with-native 编译原生模块。',
    )
  }
  const list = pids && pids.length > 0 ? [...pids].map((x) => Math.floor(Number(x))).filter((x) => x > 0) : undefined
  const raw = list && list.length > 0 ? await fn.call(nativeModule, list) : await fn.call(nativeModule)
  return parseGpuSystemSnapshotFromNative(raw)
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
