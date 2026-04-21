/**
 * Electron Memory Monitor Tool — 主进程
 *
 * 独立运行的内存监控工具，可以监控任意 Electron 应用的主进程/渲染进程内存使用情况。
 * 面向测试场景：关注持续性内存趋势、防止劣化、基线对比。
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { execFile } from 'child_process'
import {
  createPrivateWsProvider,
  getNativeModuleStatus,
  readExternalProcessMemoryNativeSync,
  enumerateProcessTreeNativeSync,
  gatherExternalMonitorSnapshotAsync,
  isNativeMemoryLoaded,
  batchGetProcessTimesAndIoSync,
  type ExternalGatheredSnapshotPayload,
  type ExternalNativeMemoryRow,
  type NativeProcessTreeRow,
  type ProcessTimesIoRow,
} from './native-memory'
import { fetchWindowsProcessTree } from './external-process-tree'
import { queryGpuSystemSnapshotCached } from './external-gpu-metrics'
import { perfChainMain, writeDiagNdjson, getDiagLogPath } from './diag-log'
import {
  computeResourceSummaryFromDataPoints,
  type ResourceSummaryPayload,
} from '../src/utils/reportResourceSummary'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// ============ 类型定义 ============

interface ProcessMemoryInfo {
  pid: number
  type: 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Zygote' | string
  name?: string
  /** 外部模式：Win32_Process.ExecutablePath */
  executablePath?: string
  /** 外部模式：Win32_Process.CommandLine */
  commandLine?: string
  /** 外部模式：--type= / utility-sub-type 摘要，供 UI 在去掉 commandLine 后仍显示角色 */
  chromiumType?: string
  cpu: { percentCPUUsage: number; idleWakeupsPerSecond: number }
  /** 外部模式：相对上一拍采样的磁盘速率（KB/s） */
  diskReadKBps?: number
  diskWriteKBps?: number
  memory: {
    workingSetSize: number
    peakWorkingSetSize: number
    /** 专用工作集 KB，来自系统层采集（Native / PowerShell） */
    privateWorkingSet?: number
  }
}

interface MemorySnapshot {
  timestamp: number
  sessionId?: string
  seq: number
  processes: ProcessMemoryInfo[]
  totalWorkingSetSize: number
  system: {
    total: number
    free: number
    used: number
    usagePercent: number
  }
  marks?: EventMark[]
  /** 采集模式：self=本工具 Electron；external=已启动 exe 的进程树（仅 Windows） */
  monitorMode?: 'self' | 'external'
  externalTargetPath?: string
  externalRootPid?: number
  /** 外部模式：参与 totalWorkingSetSize 汇总的 PID（未列出的即用户从合计中排除） */
  externalTotalIncludedPids?: number[]
  /**
   * 外部模式：CPU/磁盘为子树全部 PID 速率之和；GPU 为子树 PID 过滤的 PDH 采样。
   * 首拍无上一采样则 CPU/磁盘为 0；GPU 可能因环境无计数器而为 null。
   */
  externalMetrics?: {
    aggregateCpuPercent: number
    diskReadKBps: number
    diskWriteKBps: number
    gpuEnginePercent: number | null
    gpuDedicatedMB: number | null
  }
}

interface EventMark {
  timestamp: number
  label: string
  metadata?: Record<string, unknown>
}

interface TestSession {
  id: string
  label: string
  description?: string
  startTime: number
  endTime?: number
  snapshotCount: number
  status: 'running' | 'completed'
  dataFile: string
}

// ============ 状态管理 ============

let mainWindow: BrowserWindow | null = null

function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

/** 当前会话 */
let currentSession: TestSession | null = null

/** 快照序列号 */
let snapshotSeq = 0

/** 内存快照缓存（当前会话） */
let snapshotsBuffer: MemorySnapshot[] = []

/** 待处理的事件标记 */
let pendingMarks: EventMark[] = []

/** 定时采集器 */
let collectTimer: ReturnType<typeof setInterval> | null = null
/** 采集 tick 串行队列：异步 gather 可能长于 interval，避免整拍丢弃（原 inFlight 直接 return 会长期无快照） */
let collectTickChain: Promise<void> = Promise.resolve()
/** 用于 MMT_PERF_CHAIN 观察 setInterval 是否漂移（GC/同步磁盘阻塞） */
let lastCollectScheduledAt = 0

/** 存储目录 */
let storageDir: string

/** 历史会话索引 */
let sessionsIndex: TestSession[] = []

/** 被监控的应用信息（外部应用模式） */
let targetAppInfo: {
  appName: string
  appPath: string
  startTime: Date
} | null = null

/** 外部应用子进程 */
let targetAppProcess: ReturnType<typeof execFile> | null = null

/** Windows：被监控外部应用的根 PID（exec 子进程）；非空时快照改为采集该进程树 */
let monitoredRootPid: number | null = null
let externalPidsCache: number[] = []
let externalNamesCache: Map<number, string> = new Map()
let externalExePathCache: Map<number, string> = new Map()
let externalCommandLineCache: Map<number, string> = new Map()
/** 从「进程树合计」中排除的 PID；默认空集即全部计入 */
let externalTotalExcludedPids: Set<number> = new Set()
let externalTreeLastRefresh = 0
const EXTERNAL_TREE_REFRESH_MS = 2500

/** 外部进程 CPU/磁盘：上一拍累计值（与当前拍算速率） */
let lastExternalPerfSample: {
  t: number
  map: Map<number, { user: number; kernel: number; read: number; write: number }>
} | null = null

// ============ 配置 ============

const CONFIG = {
  collectInterval: 2000,      // 采集间隔 (ms)
  maxSnapshotsPerSession: 5000,
  maxSessions: 100,
  maxSessionDuration: 24 * 60 * 60 * 1000, // 24h
  /**
   * 外部监控：为 true 时按启动 exe / 命令行筛掉子树里镜像不同的 PID（会去掉 upgrade 等，一般不推荐）。
   * 为 false 时列表 = 根 PID 的 PPID 子树；「多出来又消失」多为旧缓存 + PID 复用，已由每拍 sync enumerate 缓解。
   */
  externalSameAppTreeFilter: false,
}

/** 专用工作集（Native C++ / PowerShell）查询与缓存，与 SDK MemoryCollector 策略一致 */
const privateWsProvider = createPrivateWsProvider()
let privateWsCache: Map<number, number> = new Map()
let privateWsLastRefresh = 0
let privateWsRefreshInterval = 2000

function initPrivateWsRefreshInterval(): void {
  privateWsRefreshInterval = privateWsProvider.backend === 'native'
    ? Math.max(500, CONFIG.collectInterval)
    : Math.max(2000, CONFIG.collectInterval * 2)
}

/**
 * 异步刷新各 PID 的专用工作集缓存；当前帧仍使用上一轮缓存，与 SDK 一致。
 */
function maybeRefreshPrivateWs(pids: number[]): void {
  if (!privateWsProvider.available || pids.length === 0) return
  const now = Date.now()
  if (now - privateWsLastRefresh < privateWsRefreshInterval) return
  privateWsLastRefresh = now

  void privateWsProvider.queryPrivateWorkingSet(pids).then((map) => {
    if (map.size > 0) {
      privateWsCache = map
    }
  }).catch(() => {
    // 忽略查询失败
  })
}

function maybeRefreshExternalTree(): void {
  if (process.platform !== 'win32' || monitoredRootPid == null) return
  // 已加载 Native 时子树由 gatherExternalMonitorSnapshotAsync（线程池）刷新；此处不再起 WMI 子进程
  if (isNativeMemoryLoaded()) return

  const now = Date.now()
  if (now - externalTreeLastRefresh < EXTERNAL_TREE_REFRESH_MS) return
  externalTreeLastRefresh = now

  const root = monitoredRootPid
  void fetchWindowsProcessTree(root).then((result) => {
    applyExternalTreeFetchResult(root, result.pids, result.names, result.exePath, result.commandLine)
  })
}

function clearExternalMonitorState(): void {
  monitoredRootPid = null
  externalPidsCache = []
  externalNamesCache = new Map()
  externalExePathCache = new Map()
  externalCommandLineCache = new Map()
  externalTotalExcludedPids = new Set()
  externalTreeLastRefresh = 0
  lastExternalPerfSample = null
}

/** 根据两拍 GetProcessTimes / GetProcessIoCounters 差分得到 CPU% 与磁盘 KB/s */
function computeExternalProcessRates(
  pids: number[],
  now: number,
  current: Map<number, ProcessTimesIoRow>,
): Map<number, { cpuPct: number; readKBps: number; writeKBps: number }> {
  const out = new Map<number, { cpuPct: number; readKBps: number; writeKBps: number }>()
  const curMap = new Map<number, { user: number; kernel: number; read: number; write: number }>()
  for (const pid of pids) {
    const r = current.get(pid)
    if (r) {
      curMap.set(pid, {
        user: r.userTime100ns,
        kernel: r.kernelTime100ns,
        read: r.readBytes,
        write: r.writeBytes,
      })
    } else {
      curMap.set(pid, { user: 0, kernel: 0, read: 0, write: 0 })
    }
  }

  if (!lastExternalPerfSample) {
    lastExternalPerfSample = { t: now, map: curMap }
    for (const pid of pids) out.set(pid, { cpuPct: 0, readKBps: 0, writeKBps: 0 })
    return out
  }

  const dtMs = Math.max(1, now - lastExternalPerfSample.t)
  const dt100ns = dtMs * 10000

  for (const pid of pids) {
    const prev = lastExternalPerfSample.map.get(pid)
    const cur = curMap.get(pid)
    if (!prev || !cur) {
      out.set(pid, { cpuPct: 0, readKBps: 0, writeKBps: 0 })
      continue
    }
    const procDelta = Math.max(0, cur.user - prev.user) + Math.max(0, cur.kernel - prev.kernel)
    /** 与多核任务管理器类似：单进程可接近 100% 表示吃满约一颗逻辑核；多进程合计可超过 100% */
    const cpuPct = (100 * procDelta) / dt100ns
    const readBps = (Math.max(0, cur.read - prev.read) / dtMs) * 1000
    const writeBps = (Math.max(0, cur.write - prev.write) / dtMs) * 1000
    out.set(pid, {
      cpuPct: Math.round(cpuPct * 1000) / 1000,
      readKBps: Math.round((readBps / 1024) * 100) / 100,
      writeKBps: Math.round((writeBps / 1024) * 100) / 100,
    })
  }

  lastExternalPerfSample = { t: now, map: curMap }
  return out
}

/** 进程树刷新后：去掉已不在树中的排除项（新出现的 PID 默认仍计入合计） */
function pruneExternalExcludedToTree(displayPids: number[]): void {
  const disp = new Set(displayPids)
  for (const p of [...externalTotalExcludedPids]) {
    if (!disp.has(p)) externalTotalExcludedPids.delete(p)
  }
}

/**
 * 判断子进程是否属于「与启动的 exe 同一应用」侧（对齐任务管理器里多进程共一镜像的做法）：
 * - 根进程始终保留；
 * - 镜像路径与启动 exe **完全相同**（Chromium/CEF 系子进程多为同一 王者荣耀世界.exe + 不同 --type）；
 * - 或镜像文件名与启动 exe **相同**（同目录换盘等边缘情况）；
 * - 或命令行中出现启动 exe 的**完整规范化路径**（兼容 / 与 \\）。
 *
 * 刻意**不再**使用「仅同安装目录」规则，否则会误留同目录下的 upgrader.exe、downloader_hdiff.exe、TASLogin64.exe。
 *
 * 命令行由 Native（NtQueryInformationProcess ProcessCommandLineInformation）读取；不再使用 PowerShell/WMI 枚举子树。
 */
function filterExternalPidsToSameApp(
  rawPids: number[],
  rootPid: number,
  launchPath: string,
  exePath: Map<number, string>,
  commandLine: Map<number, string>,
): number[] {
  if (process.platform !== 'win32' || rawPids.length === 0) return rawPids

  let launchNorm: string
  try {
    launchNorm = path.resolve(launchPath).toLowerCase()
  } catch {
    return rawPids
  }
  const launchNormSlash = launchNorm.replace(/\\/g, '/')
  const launchBase = path.basename(launchNorm).toLowerCase()
  const launchDir = path.dirname(launchNorm).toLowerCase()
  const launchDirPrefix = launchDir.endsWith('\\') ? launchDir : `${launchDir}\\`

  return rawPids.filter((pid) => {
    if (pid === rootPid) return true

    const exeRaw = (exePath.get(pid) || '').trim()
    let exeNorm = ''
    if (exeRaw) {
      try {
        exeNorm = path.resolve(exeRaw).toLowerCase()
      } catch {
        exeNorm = exeRaw.toLowerCase()
      }
    }
    const cmd = (commandLine.get(pid) || '').toLowerCase()
    const exeBase = exeNorm ? path.basename(exeNorm).toLowerCase() : ''

    // 与启动器同一物理镜像（任务管理器里 gpu/renderer 等多为同一 王者荣耀世界.exe）
    if (exeNorm === launchNorm) return true
    // 同目录下同文件名（避免仅 basename 相同但路径无关的误匹配）
    if (exeBase === launchBase && exeNorm.startsWith(launchDirPrefix)) return true

    // 命令行里带完整启动路径（如 "...王者荣耀世界.exe" --type=gpu-process）
    if (launchNorm && cmd.includes(launchNorm)) return true
    if (launchNormSlash && cmd.includes(launchNormSlash)) return true

    return false
  })
}

function applyExternalStateFromTreeRows(rootPid: number, rows: NativeProcessTreeRow[]): void {
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
  applyExternalTreeFetchResult(rootPid, pids, names, exePath, commandLine)
  externalTreeLastRefresh = Date.now()
}

/**
 * 每拍同步：用 Native 重枚举根 PID 子树并写回缓存。
 * 避免「进程表 2.5s 才刷新」时仍保留已退出 PID；PID 复用后短暂把别的进程挂到旧行上，看起来像多出来又消失。
 */
function syncExternalProcessTreeFromNative(rootPid: number): void {
  if (!isNativeMemoryLoaded()) return
  const rows = enumerateProcessTreeNativeSync(rootPid)
  if (rows == null || rows.length === 0) return
  applyExternalStateFromTreeRows(rootPid, rows)
}

function applyExternalTreeFetchResult(
  rootPid: number,
  pids: number[],
  names: Map<number, string>,
  exePath: Map<number, string>,
  commandLine: Map<number, string>,
): void {
  if (pids.length === 0) {
    monitoredRootPid = null
    externalPidsCache = []
    externalNamesCache = new Map()
    externalExePathCache = new Map()
    externalCommandLineCache = new Map()
    return
  }

  externalNamesCache = names
  externalExePathCache = exePath
  externalCommandLineCache = commandLine

  const launchPath = targetAppInfo?.appPath
  let list = pids
  if (CONFIG.externalSameAppTreeFilter && launchPath) {
    const filtered = filterExternalPidsToSameApp(pids, rootPid, launchPath, exePath, commandLine)
    list = filtered.length > 0 ? filtered : [rootPid]
    if (filtered.length < pids.length) {
      console.log(
        `[MonitorTool] 同类应用进程树过滤: ${pids.length} → ${list.length} PID（已剔除与启动路径/命令行不匹配的节点）`,
      )
    }
  }
  externalPidsCache = list
  pruneExternalExcludedToTree(externalPidsCache)
}

// ============ 工具函数 ============

function generateId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function formatKB(kb: number): string {
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

/**
 * 获取有效内存值 (KB)，优先使用 privateWorkingSet（专用工作集），回退到 workingSetSize
 */
function getEffectiveMemoryKB(mem: ProcessMemoryInfo['memory']): number {
  return mem.privateWorkingSet ?? mem.workingSetSize
}

/** 与前端 ReportEventMark / SDK SessionEventMark 字段对齐，写入 report.json */
interface ReportEventMarkRow {
  timestamp: number
  label: string
  metadata?: Record<string, unknown>
  totalWorkingSetKB: number
  browserKB: number
  rendererKB: number
  gpuKB: number
}

function collectReportEventMarks(snapshots: MemorySnapshot[]): ReportEventMarkRow[] {
  const out: ReportEventMarkRow[] = []
  for (const s of snapshots) {
    if (!s.marks?.length) continue
    const browserKB = s.processes
      .filter((p) => p.type === 'Browser')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const rendererKB = s.processes
      .filter((p) => p.type === 'Tab')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const gpuKB = s.processes
      .filter((p) => p.type === 'GPU')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    for (const m of s.marks) {
      out.push({
        timestamp: m.timestamp,
        label: m.label,
        metadata: m.metadata,
        totalWorkingSetKB: s.totalWorkingSetSize,
        browserKB,
        rendererKB,
        gpuKB,
      })
    }
  }
  return out
}

// ============ 数据采集 ============

function buildSnapshotSelf(): MemorySnapshot {
  const timestamp = Date.now()
  const metrics = app.getAppMetrics()

  const processes: ProcessMemoryInfo[] = metrics.map((m) => ({
    pid: m.pid,
    type: m.type as ProcessMemoryInfo['type'],
    name: undefined,
    cpu: {
      percentCPUUsage: m.cpu.percentCPUUsage,
      idleWakeupsPerSecond: m.cpu.idleWakeupsPerSecond,
    },
    memory: {
      workingSetSize: m.memory.workingSetSize,
      peakWorkingSetSize: m.memory.peakWorkingSetSize,
      privateWorkingSet: privateWsCache.get(m.pid),
    },
  }))

  const totalWorkingSetSize = processes.reduce(
    (sum, p) => sum + getEffectiveMemoryKB(p.memory),
    0,
  )

  const systemTotal = os.totalmem()
  const systemFree = os.freemem()

  const marks = pendingMarks.length > 0 ? [...pendingMarks] : undefined
  pendingMarks = []

  maybeRefreshPrivateWs(metrics.map((m) => m.pid))

  return {
    timestamp,
    sessionId: currentSession?.id,
    seq: snapshotSeq++,
    processes,
    totalWorkingSetSize,
    system: {
      total: systemTotal,
      free: systemFree,
      used: systemTotal - systemFree,
      usagePercent: Math.round(((systemTotal - systemFree) / systemTotal) * 10000) / 100,
    },
    marks,
    monitorMode: 'self',
  }
}

/** 从完整命令行提取 Chromium/CEF 的 --type=（及 utility 子类型），供 IPC 瘦身列仍展示角色 */
function parseChromiumProcessRole(cmd: string | undefined): string | undefined {
  if (cmd == null || typeof cmd !== 'string') return undefined
  const trimmed = cmd.trim()
  if (!trimmed) return undefined
  const typeM = trimmed.match(/--type=([^\s"']+)/i)
  if (!typeM || !typeM[1]) return undefined
  const raw = typeM[1]
  const t = raw.toLowerCase()
  if (t === 'utility') {
    const subM = trimmed.match(/--utility-sub-type=([^\s"']+)/i)
    const sub = subM && subM[1] ? subM[1] : ''
    const combo = sub ? `utility:${sub}` : 'utility'
    return combo.length > 96 ? `${combo.slice(0, 93)}...` : combo
  }
  return raw.length > 64 ? `${raw.slice(0, 61)}...` : raw
}

/** 在已有子树缓存与内存/TimesIo Map 上组装外部 MemorySnapshot（主线程轻量）。 */
function composeExternalSnapshot(
  timestamp: number,
  root: number,
  displayPids: number[],
  nativeMem: Map<number, ExternalNativeMemoryRow>,
  timesIo: Map<number, ProcessTimesIoRow>,
): MemorySnapshot {
  const rates = computeExternalProcessRates(displayPids, timestamp, timesIo)
  const gpuSnap = queryGpuSystemSnapshotCached(displayPids)

  const processes: ProcessMemoryInfo[] = displayPids.map((pid) => {
    const row = nativeMem.get(pid)
    const privKb = row?.privateKb ?? 0
    const wsKb = row?.workingSetKb ?? 0
    const peakKb = row?.peakKb ?? wsKb
    const isRoot = pid === root
    const exe = externalExePathCache.get(pid)
    const cmd = externalCommandLineCache.get(pid)
    const r = rates.get(pid)
    return {
      pid,
      type: (isRoot ? 'Browser' : 'Tab') as ProcessMemoryInfo['type'],
      name: externalNamesCache.get(pid),
      executablePath: exe,
      commandLine: cmd,
      chromiumType: parseChromiumProcessRole(cmd),
      cpu: { percentCPUUsage: r?.cpuPct ?? 0, idleWakeupsPerSecond: 0 },
      diskReadKBps: r?.readKBps ?? 0,
      diskWriteKBps: r?.writeKBps ?? 0,
      memory: {
        workingSetSize: wsKb,
        peakWorkingSetSize: peakKb,
        privateWorkingSet: privKb,
      },
    }
  }).sort((a, b) => getEffectiveMemoryKB(b.memory) - getEffectiveMemoryKB(a.memory))

  const includedPids = displayPids.filter((pid) => !externalTotalExcludedPids.has(pid))
  const totalWorkingSetSize = processes
    .filter((p) => includedPids.includes(p.pid))
    .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)

  let aggregateCpuPercent = 0
  let diskReadKBps = 0
  let diskWriteKBps = 0
  for (const pid of displayPids) {
    const r = rates.get(pid)
    if (r) {
      aggregateCpuPercent += r.cpuPct
      diskReadKBps += r.readKBps
      diskWriteKBps += r.writeKBps
    }
  }
  aggregateCpuPercent = Math.round(aggregateCpuPercent * 100) / 100
  diskReadKBps = Math.round(diskReadKBps * 100) / 100
  diskWriteKBps = Math.round(diskWriteKBps * 100) / 100

  const systemTotal = os.totalmem()
  const systemFree = os.freemem()

  const marks = pendingMarks.length > 0 ? [...pendingMarks] : undefined
  pendingMarks = []

  return {
    timestamp,
    sessionId: currentSession?.id,
    seq: snapshotSeq++,
    processes,
    totalWorkingSetSize,
    system: {
      total: systemTotal,
      free: systemFree,
      used: systemTotal - systemFree,
      usagePercent: Math.round(((systemTotal - systemFree) / systemTotal) * 10000) / 100,
    },
    marks,
    monitorMode: 'external',
    externalTargetPath: targetAppInfo?.appPath,
    externalRootPid: root,
    externalTotalIncludedPids: [...includedPids].sort((a, b) => a - b),
    externalMetrics: {
      aggregateCpuPercent,
      diskReadKBps,
      diskWriteKBps,
      gpuEnginePercent: gpuSnap.engineUtilPercent,
      gpuDedicatedMB: gpuSnap.dedicatedUsedMB,
    },
  }
}

/** 同步路径：整拍在主线程完成（IPC 即时刷新等短操作仍可用）。 */
function buildSnapshotExternalSync(): MemorySnapshot {
  const timestamp = Date.now()
  const root = monitoredRootPid!
  syncExternalProcessTreeFromNative(root)
  maybeRefreshExternalTree()

  const displayPids = externalPidsCache.length > 0 ? externalPidsCache : [root]
  pruneExternalExcludedToTree(displayPids)

  const nativeMem = readExternalProcessMemoryNativeSync(displayPids)
  const timesIo = batchGetProcessTimesAndIoSync(displayPids)
  return composeExternalSnapshot(timestamp, root, displayPids, nativeMem, timesIo)
}

/** 定时采集路径：子树 + 内存 + Times/IO 在 Native AsyncWorker 中执行，避免主线程长时间「未响应」。 */
async function buildSnapshotExternalAsync(): Promise<MemorySnapshot> {
  const timestamp = Date.now()
  const root = monitoredRootPid!
  const gathered: ExternalGatheredSnapshotPayload | null = await gatherExternalMonitorSnapshotAsync(root)

  if (gathered && gathered.tree.length > 0) {
    applyExternalStateFromTreeRows(root, gathered.tree)
  } else {
    syncExternalProcessTreeFromNative(root)
  }
  maybeRefreshExternalTree()

  const displayPids = externalPidsCache.length > 0 ? externalPidsCache : [root]
  pruneExternalExcludedToTree(displayPids)

  let nativeMem: Map<number, ExternalNativeMemoryRow>
  let timesIo: Map<number, ProcessTimesIoRow>
  if (
    gathered &&
    gathered.tree.length > 0 &&
    gathered.memory.size > 0 &&
    displayPids.length > 0 &&
    displayPids.every((pid) => gathered.memory.has(pid) && gathered.timesIo.has(pid))
  ) {
    nativeMem = gathered.memory
    timesIo = gathered.timesIo
  } else {
    nativeMem = readExternalProcessMemoryNativeSync(displayPids)
    timesIo = batchGetProcessTimesAndIoSync(displayPids)
  }

  return composeExternalSnapshot(timestamp, root, displayPids, nativeMem, timesIo)
}

async function buildSnapshotAsync(): Promise<MemorySnapshot> {
  if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
    return buildSnapshotExternalAsync()
  }
  return buildSnapshotSelf()
}

function buildSnapshot(): MemorySnapshot {
  if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
    return buildSnapshotExternalSync()
  }
  return buildSnapshotSelf()
}

// ============ 会话管理 ============

function ensureStorageDir(): void {
  storageDir = path.join(app.getPath('userData'), 'monitor-sessions')
  fs.mkdirSync(storageDir, { recursive: true })
  loadSessionsIndex()
}

function healStaleRunningSessionsInIndex(reason: string): boolean {
  let changed = false
  const now = Date.now()
  for (const s of sessionsIndex) {
    if (s.status === 'running') {
      s.status = 'completed'
      s.endTime = now
      changed = true
    }
  }
  if (changed) {
    saveSessionsIndex()
    console.warn(`[MonitorTool] 已收口索引中异常的「进行中」会话（${reason}）`)
  }
  return changed
}

function loadSessionsIndex(): void {
  const indexPath = path.join(storageDir, 'sessions.json')
  try {
    if (fs.existsSync(indexPath)) {
      sessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
    }
  } catch {
    sessionsIndex = []
  }
  // 异常退出后磁盘上可能残留 running，与主进程 currentSession=null 不一致，启动时统一收口
  healStaleRunningSessionsInIndex('应用启动时索引恢复')
}

function saveSessionsIndex(): void {
  const indexPath = path.join(storageDir, 'sessions.json')
  fs.writeFileSync(indexPath, JSON.stringify(sessionsIndex, null, 2), 'utf-8')
}

function startSession(label: string, description?: string): TestSession {
  // 如果有正在运行的会话，先结束它
  if (currentSession && currentSession.status === 'running') {
    endSession()
  }

  const id = generateId()
  const session: TestSession = {
    id,
    label,
    description,
    startTime: Date.now(),
    snapshotCount: 0,
    status: 'running',
    dataFile: `${id}.snapshots`,
  }

  currentSession = session
  snapshotsBuffer = []
  snapshotSeq = 0

  // 加入索引并持久化
  sessionsIndex.unshift(session)
  saveSessionsIndex()

  broadcastToRenderer('session:started', session)

  perfChainMain('startSession', { sessionId: session.id, label })
  console.log(`[MonitorTool] Session started: ${label} (${session.id})`)
  return session
}

function endSession(): TestSession | null {
  if (!currentSession || currentSession.status !== 'running') return null

  const endedRef = currentSession
  const buffer = snapshotsBuffer

  let report: ReportSummary
  try {
    const sessionDataFile = path.join(storageDir, endedRef.dataFile)
    const lines = buffer.map((s) => JSON.stringify(s))
    fs.writeFileSync(sessionDataFile, lines.join('\n'), 'utf-8')
    report = generateReportSummary(endedRef, buffer)
    fs.writeFileSync(
      path.join(storageDir, `${endedRef.id}.report.json`),
      JSON.stringify(report, null, 2),
      'utf-8',
    )
  } catch (err) {
    console.error('[MonitorTool] endSession 持久化失败（仍会结束会话）:', err)
    try {
      report = generateReportSummary(endedRef, buffer)
    } catch {
      report = {
        sessionId: endedRef.id,
        label: endedRef.label,
        description: endedRef.description,
        startTime: endedRef.startTime,
        endTime: Date.now(),
        durationMs: 0,
        snapshotCount: buffer.length,
        summary: {
          peakTotalMB: 0,
          avgTotalMB: 0,
          finalTotalMB: 0,
          peakBrowserMB: 0,
          peakRendererMB: 0,
          peakProcessCount: 0,
        },
        trendAnalysis: {
          hasGrowthTrend: false,
          growthRatePerMin: 0,
          growthAmountMB: 0,
          conclusion: 'PASS',
          reason: '报告生成失败，已结束会话',
        },
        dataPoints: [],
      }
    }
  }

  endedRef.endTime = Date.now()
  endedRef.status = 'completed'
  endedRef.snapshotCount = buffer.length

  saveSessionsIndex()

  broadcastToRenderer('session:ended', { session: endedRef, report })

  currentSession = null
  snapshotsBuffer = []

  console.log(`[MonitorTool] Session ended: ${endedRef.label}`)
  return endedRef
}

// ============ 报告生成 ============

interface ReportSummary {
  sessionId: string
  label: string
  description?: string
  startTime: number
  endTime: number
  durationMs: number
  snapshotCount: number

  // 摘要统计
  summary: {
    /** 总内存峰值 (MB) */
    peakTotalMB: number
    /** 总内存均值 (MB) */
    avgTotalMB: number
    /** 总内存末值 (MB) */
    finalTotalMB: number
    /** 主进程峰值 (MB) */
    peakBrowserMB: number
    /** 渲染进程峰值 (MB) */
    peakRendererMB: number
    /** 进程数峰值 */
    peakProcessCount: number
  }

  // 趋势分析（面向测试的解读）
  trendAnalysis: {
    /** 是否检测到持续增长（可能泄漏） */
    hasGrowthTrend: boolean
    /** 增长率估算 (%/min) */
    growthRatePerMin: number
    /** 增长量 (MB) */
    growthAmountMB: number
    /** 测试结论 */
    conclusion: 'PASS' | 'WARN' | 'FAIL'
    /** 结论说明 */
    reason: string
  }

  /** 各采样点数据（精简版） */
  dataPoints: Array<{
    timestamp: number
    totalMB: number
    browserMB: number
    rendererMB: number
    gpuMB: number
    processCount: number
    /** 外部模式：子树 CPU/磁盘 KB/s、子树 PID 过滤 GPU（与快照 externalMetrics 一致） */
    extCpuPercent?: number
    extDiskReadKBps?: number
    extDiskWriteKBps?: number
    extGpuEnginePercent?: number | null
    extGpuDedicatedMB?: number | null
  }>

  /** 外部监控：进程树合计所依据的 PID 及名称（取会话结束时最后一次采样） */
  externalTotalMemoryBasis?: {
    includedPids: number[]
    labels: Record<string, string>
    note: string
  }

  eventMarks?: ReportEventMarkRow[]

  resourceSummary?: ResourceSummaryPayload
}

function generateReportSummary(session: TestSession, snapshots: MemorySnapshot[]): ReportSummary {
  if (snapshots.length === 0) {
    return {
      sessionId: session.id,
      label: session.label,
      description: session.description,
      startTime: session.startTime,
      endTime: Date.now(),
      durationMs: Date.now() - session.startTime,
      snapshotCount: 0,
      summary: { peakTotalMB: 0, avgTotalMB: 0, finalTotalMB: 0, peakBrowserMB: 0, peakRendererMB: 0, peakProcessCount: 0 },
      trendAnalysis: { hasGrowthTrend: false, growthRatePerMin: 0, growthAmountMB: 0, conclusion: 'PASS', reason: '无数据' },
      dataPoints: [],
      eventMarks: [],
    }
  }

  // 计算各指标
  let peakTotal = 0
  let sumTotal = 0
  let peakBrowser = 0
  let peakRenderer = 0
  let peakProcCount = 0

  const dataPoints = snapshots.map((s) => {
    const browserMem = s.processes
      .filter((p) => p.type === 'Browser')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const rendererMem = s.processes
      .filter((p) => p.type === 'Tab')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const gpuMem = s.processes
      .filter((p) => p.type === 'GPU')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)

    const totalMB = Math.round(s.totalWorkingSetSize / 1024 * 10) / 10
    const browserMB = Math.round(browserMem / 1024 * 10) / 10
    const rendererMB = Math.round(rendererMem / 1024 * 10) / 10
    const gpuMB = Math.round(gpuMem / 1024 * 10) / 10

    peakTotal = Math.max(peakTotal, s.totalWorkingSetSize)
    sumTotal += s.totalWorkingSetSize
    peakBrowser = Math.max(peakBrowser, browserMem)
    peakRenderer = Math.max(peakRenderer, rendererMem)
    peakProcCount = Math.max(peakProcCount, s.processes.length)

    const pt: ReportSummary['dataPoints'][number] = {
      timestamp: s.timestamp,
      totalMB,
      browserMB,
      rendererMB,
      gpuMB,
      processCount: s.processes.length,
    }
    if (s.monitorMode === 'external' && s.externalMetrics) {
      pt.extCpuPercent = s.externalMetrics.aggregateCpuPercent
      pt.extDiskReadKBps = s.externalMetrics.diskReadKBps
      pt.extDiskWriteKBps = s.externalMetrics.diskWriteKBps
      pt.extGpuEnginePercent = s.externalMetrics.gpuEnginePercent
      pt.extGpuDedicatedMB = s.externalMetrics.gpuDedicatedMB
    }
    return pt
  })

  // 趋势分析
  const first = dataPoints[0]
  const last = dataPoints[dataPoints.length - 1]
  const durationMin = ((last.timestamp - first.timestamp) / 60000) || 1
  const growthMB = last.totalMB - first.totalMB
  const growthRatePerMin = (growthMB / durationMin)

  // 取前 20% 和后 20% 的平均值做对比（更稳健的趋势判断）
  const q1 = Math.floor(dataPoints.length * 0.1)
  const q9 = Math.floor(dataPoints.length * 0.9)
  const earlyAvg = dataPoints.slice(0, Math.max(q1, 3)).reduce((s, d) => s + d.totalMB, 0) / Math.max(q1, 3)
  const lateAvg = dataPoints.slice(q9).reduce((s, d) => s + d.totalMB, 0) / Math.max(dataPoints.length - q9, 1)
  const sustainedGrowth = lateAvg - earlyAvg

  let conclusion: 'PASS' | 'WARN' | 'FAIL' = 'PASS'
  let reason = ''
  const growthThresholdMB = 50   // 增长超过 50MB 视为可疑
  const growthThresholdPct = 15  // 增长超过 15% 视为可疑

  if (sustainedGrowth > growthThresholdMB && (sustainedGrowth / earlyAvg) * 100 > growthThresholdPct) {
    if (sustainedGrowth > 200 || (sustainedGrowth / earlyAvg) * 100 > 40) {
      conclusion = 'FAIL'
      reason = `检测到显著内存增长 (+${sustainedGrowth.toFixed(1)} MB, ${(sustainedGrowth / earlyAvg * 100).toFixed(1)}%)，存在内存泄漏风险。建议排查是否有未释放的大对象、事件监听器或定时器。`
    } else {
      conclusion = 'WARN'
      reason = `检测到轻微但持续的内存增长 (+${sustainedGrowth.toFixed(1)} MB)。建议关注长期运行是否进一步恶化，可延长测试时间确认。`
    }
  } else {
    conclusion = 'PASS'
    reason = '内存使用稳定，无明显增长趋势。'
  }

  const resourceSummary = computeResourceSummaryFromDataPoints(dataPoints)

  const lastSnap = snapshots[snapshots.length - 1]
  let externalTotalMemoryBasis: ReportSummary['externalTotalMemoryBasis']
  if (
    lastSnap?.monitorMode === 'external' &&
    Array.isArray(lastSnap.externalTotalIncludedPids)
  ) {
    const labels: Record<string, string> = {}
    for (const pid of lastSnap.externalTotalIncludedPids) {
      const row = lastSnap.processes.find((pr) => pr.pid === pid)
      labels[String(pid)] = row?.name || `PID ${pid}`
    }
    externalTotalMemoryBasis = {
      includedPids: [...lastSnap.externalTotalIncludedPids],
      labels,
      note: `「进程树合计」仅累加下列 ${lastSnap.externalTotalIncludedPids.length} 个 PID；列表中未勾选的进程未计入合计。`,
    }
  }

  return {
    sessionId: session.id,
    label: session.label,
    description: session.description,
    startTime: session.startTime,
    endTime: Date.now(),
    durationMs: Date.now() - session.startTime,
    snapshotCount: snapshots.length,

    summary: {
      peakTotalMB: Math.round(peakTotal / 1024 * 10) / 10,
      avgTotalMB: Math.round(sumTotal / snapshots.length / 1024 * 10) / 10,
      finalTotalMB: dataPoints[dataPoints.length - 1].totalMB,
      peakBrowserMB: Math.round(peakBrowser / 1024 * 10) / 10,
      peakRendererMB: Math.round(peakRenderer / 1024 * 10) / 10,
      peakProcessCount: peakProcCount,
    },

    trendAnalysis: {
      hasGrowthTrend: conclusion !== 'PASS',
      growthRatePerMin: Math.round(growthRatePerMin * 100) / 100,
      growthAmountMB: Math.round(growthMB * 100) / 100,
      conclusion,
      reason,
    },

    dataPoints,
    eventMarks: collectReportEventMarks(snapshots),
    ...(externalTotalMemoryBasis ? { externalTotalMemoryBasis } : {}),
    ...(resourceSummary ? { resourceSummary } : {}),
  }
}

// ============ 对比报告 ============

interface CompareResult {
  baseSession: { id: string; label: string }
  targetSession: { id: string; label: string }
  comparison: {
    /** 峰值差异 (MB) */
    peakDiffMB: number
    /** 峰值变化率 (%) */
    peakChangePercent: number
    /** 均值差异 (MB) */
    avgDiffMB: number
    /** 均值变化率 (%) */
    avgChangePercent: number
    /** 末值差异 (MB) */
    finalDiffMB: number
  }
  /** 测试解读 */
  verdict: {
    status: 'IMPROVED' | 'REGRESSION' | 'STABLE' | 'INCONCLUSIVE'
    summary: string
    details: string[]
  }
}

function compareReports(base: ReportSummary, target: ReportSummary): CompareResult {
  const peakDiff = target.summary.peakTotalMB - base.summary.peakTotalMB
  const peakChange = base.summary.peakTotalMB > 0 ? (peakDiff / base.summary.peakTotalMB) * 100 : 0
  const avgDiff = target.summary.avgTotalMB - base.summary.avgTotalMB
  const avgChange = base.summary.avgTotalMB > 0 ? (avgDiff / base.summary.avgTotalMB) * 100 : 0
  const finalDiff = target.summary.finalTotalMB - base.summary.finalTotalMB

  // 判定回归阈值
  const regressionThreshold = 10   // 10% 以上视为回归
  const improvementThreshold = -5  // -5% 以上视为改善

  let status: CompareResult['verdict']['status'] = 'STABLE'
  const details: string[] = []

  if (peakChange > regressionThreshold) {
    status = 'REGRESSION'
    details.push(`⚠️ 峰值内存增加 ${peakChange.toFixed(1)}%（+${peakDiff.toFixed(1)} MB）`)
  } else if (peakChange < improvementThreshold) {
    status = 'IMPROVED'
    details.push(`✅ 峰值内存降低 ${Math.abs(peakChange).toFixed(1)}%（${peakDiff.toFixed(1)} MB）`)
  } else {
    details.push(`✓ 峰值内存基本持平（变化 ${peakChange.toFixed(1)}%）`)
  }

  if (avgChange > regressionThreshold) {
    if (status !== 'REGRESSION') status = 'REGRESSION'
    details.push(`⚠️ 平均内存增加 ${avgChange.toFixed(1)}%（+${avgDiff.toFixed(1)} MB）`)
  } else if (avgChange < improvementThreshold) {
    details.push(`✅ 平均内存降低 ${Math.abs(avgChange).toFixed(1)}%（${avgDiff.toFixed(1)} MB）`)
  } else {
    details.push(`✓ 平均内存基本持平（变化 ${avgChange.toFixed(1)}%）`)
  }

  if (base.trendAnalysis.conclusion === 'PASS' && target.trendAnalysis.conclusion === 'FAIL') {
    status = 'REGRESSION'
    details.push('🔴 基线版本通过稳定性测试，目标版本失败！')
  } else if (base.trendAnalysis.conclusion === 'FAIL' && target.trendAnalysis.conclusion === 'PASS') {
    if (status === 'STABLE') status = 'IMPROVED'
    details.push('🟢 目标版本通过稳定性测试，基线版本曾失败！')
  }

  const summaryMap: Record<CompareResult['verdict']['status'], string> = {
    REGRESSION: `检测到内存回归！目标版本相比基线内存使用明显上升，需要关注。`,
    IMPROVED: `目标版本内存表现优于基线，继续保持。`,
    STABLE: `两版本内存表现基本一致，无明显回归。`,
    INCONCLUSIVE: `数据不足以做出判断，建议在相同条件下重新测试。`,
  }

  if (details.length === 0) {
    status = 'INCONCLUSIVE'
  }

  return {
    baseSession: { id: base.sessionId, label: base.label },
    targetSession: { id: target.sessionId, label: target.label },
    comparison: {
      peakDiffMB: Math.round(peakDiff * 100) / 100,
      peakChangePercent: Math.round(peakChange * 100) / 100,
      avgDiffMB: Math.round(avgDiff * 100) / 100,
      avgChangePercent: Math.round(avgChange * 100) / 100,
      finalDiffMB: Math.round(finalDiff * 100) / 100,
    },
    verdict: {
      status,
      summary: summaryMap[status],
      details,
    },
  }
}

// ============ 采集控制 ============

function enqueueCollectTick(): void {
  collectTickChain = collectTickChain
    .then(() => runCollectTickBody())
    .catch((err) => {
      console.error('[MonitorTool] collect tick failed:', err)
    })
}

async function runCollectTickBody(): Promise<void> {
  const now = Date.now()
  const driftMs = lastCollectScheduledAt ? now - lastCollectScheduledAt - CONFIG.collectInterval : 0
  lastCollectScheduledAt = now
  const b0 = Date.now()
  const snapshot = await buildSnapshotAsync()
  const buildMs = Date.now() - b0
  perfChainMain('collect_tick', {
    driftMs,
    buildMs,
    seq: snapshot.seq,
    monitorMode: snapshot.monitorMode ?? 'self',
    procCount: snapshot.processes.length,
  })
  pushSnapshot(snapshot)
}

function startCollecting(): void {
  if (collectTimer) return

  initPrivateWsRefreshInterval()

  // 立即采集一次（外部模式走异步 gather，避免首帧卡死 UI）
  lastCollectScheduledAt = Date.now()
  enqueueCollectTick()

  collectTimer = setInterval(() => {
    enqueueCollectTick()
  }, CONFIG.collectInterval)

  console.log('[MonitorTool] Collection started, interval:', CONFIG.collectInterval, 'ms')
  perfChainMain('startCollecting', {
    intervalMs: CONFIG.collectInterval,
    note: '单一定时器；每 interval 仅 buildSnapshot 一次 + pushSnapshot',
  })
}

function stopCollecting(): void {
  if (collectTimer) {
    clearInterval(collectTimer)
    collectTimer = null
  }
  console.log('[MonitorTool] Collection stopped')
}

/** 实时 UI 去掉超长 commandLine；保留 chromiumType 短字段便于展示 --type= 角色 */
function slimSnapshotForUiBroadcast(full: MemorySnapshot): MemorySnapshot {
  if (full.processes.length === 0) return full
  return {
    ...full,
    processes: full.processes.map((p) => {
      const { commandLine: _drop, ...rest } = p
      return rest
    }),
  }
}

function pushSnapshot(snapshot: MemorySnapshot): void {
  // 缓存到缓冲区
  snapshotsBuffer.push(snapshot)

  let diskWriteMs = 0
  // 如果有正在进行的会话，写入磁盘
  if (currentSession?.status === 'running') {
    const sessionDataFile = path.join(storageDir, currentSession.dataFile)
    try {
      const d0 = Date.now()
      fs.appendFileSync(sessionDataFile, JSON.stringify(snapshot) + '\n', 'utf-8')
      diskWriteMs = Date.now() - d0
      currentSession.snapshotCount++
    } catch (err) {
      console.error('[MonitorTool] Failed to write snapshot:', err)
    }
  }

  const s0 = Date.now()
  const slim = slimSnapshotForUiBroadcast(snapshot)
  const slimMs = Date.now() - s0

  // 推送到 UI：磁盘仍写完整快照，IPC 用瘦身副本（尤其外部子树 commandLine 极长时）
  const send0 = Date.now()
  broadcastToRenderer('snapshot:update', slim)
  const ipcSendMs = Date.now() - send0

  perfChainMain('pushSnapshot', {
    seq: snapshot.seq,
    diskWriteMs,
    slimMs,
    ipcSendMs,
    procCount: snapshot.processes.length,
    monitorMode: snapshot.monitorMode ?? 'self',
  })

  // 限制缓冲区大小
  if (snapshotsBuffer.length > CONFIG.maxSnapshotsPerSession) {
    snapshotsBuffer = snapshotsBuffer.slice(-CONFIG.maxSnapshotsPerSession / 2)
  }
}

// ============ 外部应用启动 ============

interface LaunchAppResult {
  success: boolean
  error?: string
  info?: { appPath: string; appName: string }
  session?: TestSession
}

async function launchTargetApp(appPath: string, args: string[]): Promise<LaunchAppResult> {
  perfChainMain('launchTargetApp_begin', { appPath })
  try {
    const appName = path.basename(appPath).replace(/\.(exe|app|bat|sh)$/, '')
    targetAppInfo = {
      appName,
      appPath,
      startTime: new Date(),
    }

    return await new Promise<LaunchAppResult>((resolve) => {
      // @types/node 中 execFile 的 options 重载较窄，运行时需要 stdio 以捕获 stderr
      const execOpts = {
        cwd: path.dirname(appPath),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'] as const,
      } as Parameters<typeof execFile>[2]
      targetAppProcess = execFile(appPath, args, execOpts, (err) => {
        console.log(
          `[MonitorTool] Target app exited`,
          err ? `code=${(err as NodeJS.ErrnoException).code ?? '?'}` : 'ok',
        )
        targetAppProcess = null
        targetAppInfo = null
        clearExternalMonitorState()
      })

      targetAppProcess.stderr?.on('data', (data: Buffer) => {
        console.log(`[TargetApp][stderr]: ${data.toString().trim()}`)
      })

      const childPid = targetAppProcess.pid
      if (typeof childPid !== 'number' || childPid <= 0) {
        console.error('[MonitorTool] 无法获取目标进程 PID')
        targetAppProcess = null
        targetAppInfo = null
        clearExternalMonitorState()
        resolve({ success: false, error: '无法获取目标进程 PID' })
        return
      }

      privateWsCache = new Map()
      privateWsLastRefresh = 0
      lastExternalPerfSample = null
      externalTotalExcludedPids = new Set()
      externalPidsCache = [childPid]
      externalNamesCache = new Map([[childPid, appName]])
      externalExePathCache = new Map([[childPid, appPath]])
      externalCommandLineCache = new Map()
      externalTreeLastRefresh = 0
      if (isNativeMemoryLoaded()) {
        monitoredRootPid = childPid
        syncExternalProcessTreeFromNative(childPid)
        perfChainMain('launchTargetApp_tree_applied', {
          rootPid: childPid,
          pidCount: externalPidsCache.length,
        })
      } else {
        monitoredRootPid = null
        console.warn(
          '[MonitorTool] memory_native.node 未加载，无法按 C++ 路径采集外部进程树内存。请在本应用目录执行 pnpm run build:with-native 编译 native 后再试。',
        )
      }
      if (!isNativeMemoryLoaded()) {
        void fetchWindowsProcessTree(childPid).then((result) => {
          applyExternalTreeFetchResult(childPid, result.pids, result.names, result.exePath, result.commandLine)
          perfChainMain('launchTargetApp_tree_applied', {
            rootPid: childPid,
            pidCount: result.pids.length,
          })
        })
      }

      // 为本次「启动并监控」自动新开测试会话（会结束当前运行中的会话）
      const session = startSession(`启动: ${appName}`, `可执行文件: ${appPath}`)
      perfChainMain('launchTargetApp_resolve', { sessionId: session.id, childPid, collectIntervalMs: CONFIG.collectInterval })
      // 勿延迟 resolve：IPC 若挂起 1.5s 会拖住 invoke，前端表现为按钮点击后假死
      resolve({ success: true, info: { appPath, appName }, session })
    })
  } catch (err) {
    console.error('[MonitorTool] Failed to launch target app:', err)
    targetAppInfo = null
    clearExternalMonitorState()
    return { success: false, error: String(err) }
  }
}

// ============ IPC 处理 ============

function registerIpcHandlers(): void {
  /** 渲染进程诊断写入同一 NDJSON 文件（不重复 console） */
  ipcMain.on('diag:append', (_e, record: unknown) => {
    if (!record || typeof record !== 'object') return
    writeDiagNdjson({ ...(record as Record<string, unknown>), source: 'renderer' }, true)
  })

  ipcMain.handle('diag:get-log-path', (): string | null => getDiagLogPath())

  // ---- 采集控制 ----
  ipcMain.handle('collect:start', () => {
    startCollecting()
    return true
  })

  ipcMain.handle('collect:stop', () => {
    stopCollecting()
    return true
  })

  // ---- 会话管理 ----
  ipcMain.handle('session:start', (_e, label: string, desc?: string) => {
    const session = startSession(label, desc)
    return session
  })

  ipcMain.handle('session:stop', async () => {
    try {
      if (currentSession?.status === 'running') {
        return endSession()
      }
      healStaleRunningSessionsInIndex('结束会话时主进程无活动会话')
      broadcastToRenderer('session:ended', { session: null, report: null })
      return null
    } catch (err) {
      console.error('[MonitorTool] session:stop 异常:', err)
      healStaleRunningSessionsInIndex('结束会话异常恢复')
      currentSession = null
      snapshotsBuffer = []
      broadcastToRenderer('session:ended', { session: null, report: null })
      return null
    }
  })

  ipcMain.handle('session:list', (): TestSession[] => {
    return sessionsIndex
  })

  ipcMain.handle('session:get-report', (_e, sessionId: string): ReportSummary | null => {
    const reportFile = path.join(storageDir, `${sessionId}.report.json`)
    try {
      if (fs.existsSync(reportFile)) {
        return JSON.parse(fs.readFileSync(reportFile, 'utf-8'))
      }
    } catch { /* ignore */ }
    return null
  })

  ipcMain.handle('session:get-snapshots', (_e, sessionId: string, maxPoints?: number): MemorySnapshot[] => {
    const snapFile = path.join(storageDir, `${sessionId.replace('sess_', '')}.snapshots`)
    // 尝试匹配
    const directFile = path.join(storageDir, `${sessionId}.snapshots`)
    for (const f of [snapFile, directFile]) {
      try {
        if (fs.existsSync(f)) {
          const content = fs.readFileSync(f, 'utf-8')
          const lines = content.trim().split('\n').filter(Boolean)
          let snapshots = lines.map((l) => JSON.parse(l) as MemorySnapshot)

          // 降采样
          if (maxPoints && snapshots.length > maxPoints) {
            const step = snapshots.length / maxPoints
            const sampled: MemorySnapshot[] = []
            for (let i = 0; i < maxPoints; i++) {
              sampled.push(snapshots[Math.round(i * step)])
            }
            snapshots = sampled
          }
          return snapshots
        }
      } catch { /* ignore */ }
    }
    return []
  })

  ipcMain.handle('session:delete', async (_e, sessionId: string): Promise<boolean> => {
    try {
      // 删除关联文件
      const files = [
        `${sessionId}.snapshots`,
        `${sessionId}.report.json`,
      ]
      for (const f of files) {
        const fp = path.join(storageDir, f)
        if (fs.existsSync(fp)) fs.unlinkSync(fp)
      }
      // 从索引移除
      sessionsIndex = sessionsIndex.filter((s) => s.id !== sessionId)
      saveSessionsIndex()
      return true
    } catch {
      return false
    }
  })

  // ---- 对比 ----
  ipcMain.handle('session:compare', (_e, baseId: string, targetId: string): CompareResult | null => {
    const baseReport = getSessionReport(baseId)
    const targetReport = getSessionReport(targetId)
    if (!baseReport || !targetReport) return null
    return compareReports(baseReport, targetReport)
  })

  function getSessionReport(sessionId: string): ReportSummary | null {
    const reportFile = path.join(storageDir, `${sessionId}.report.json`)
    try {
      if (fs.existsSync(reportFile)) {
        return JSON.parse(fs.readFileSync(reportFile, 'utf-8')) as ReportSummary
      }
    } catch { /* ignore */ }
    return null
  }

  // ---- 标记 ----
  ipcMain.handle('mark:add', (_e, label: string, metadata?: Record<string, unknown>) => {
    pendingMarks.push({
      timestamp: Date.now(),
      label,
      metadata,
    })
    return true
  })

  // ---- 外部应用启动 ----
  ipcMain.handle('app:launch', async (_e, appPath: string, args: string[]) => {
    return launchTargetApp(appPath, args)
  })

  ipcMain.handle('app:get-target', () => {
    if (!targetAppInfo) return null
    return {
      appName: targetAppInfo.appName,
      appPath: targetAppInfo.appPath,
      startTime: targetAppInfo.startTime.toISOString(),
    }
  })

  /** 外部进程树：从「进程树合计」中排除的 PID（默认无排除即全选） */
  ipcMain.handle('external:get-excluded-pids', (): number[] => {
    return [...externalTotalExcludedPids].sort((a, b) => a - b)
  })

  ipcMain.handle('external:set-pid-excluded', (_e, pid: number, excluded: boolean): boolean => {
    if (!Number.isFinite(pid) || pid <= 0) return false
    const id = Math.floor(pid)
    if (excluded) externalTotalExcludedPids.add(id)
    else externalTotalExcludedPids.delete(id)
    if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
      void buildSnapshotExternalAsync()
        .then((snapshot) => {
          pushSnapshot(snapshot)
        })
        .catch((err) => {
          console.error('[MonitorTool] 排除设置后刷新快照失败:', err)
        })
    }
    return true
  })

  ipcMain.handle('external:reset-total-exclusion', (): boolean => {
    externalTotalExcludedPids.clear()
    if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
      void buildSnapshotExternalAsync()
        .then((snapshot) => {
          pushSnapshot(snapshot)
        })
        .catch((err) => {
          console.error('[MonitorTool] 重置排除后刷新快照失败:', err)
        })
    }
    return true
  })

  ipcMain.handle('dialog:pick-exe', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win) return { canceled: true as const }
    const r = await dialog.showOpenDialog(win, {
      title: '选择要监控的可执行文件',
      filters: [
        { name: '可执行文件', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true as const }
    return { canceled: false as const, path: r.filePaths[0] }
  })

  // ---- 导出 ----
  ipcMain.handle('export:session', async (_e, sessionId: string) => {
    try {
      const session = sessionsIndex.find((s) => s.id === sessionId)
      if (!session) return { success: false, error: '会话不存在' }

      const defaultName = `memory-monitor-${session.label.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')}.json`

      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出会话报告',
        defaultPath: defaultName,
        filters: [
          { name: 'JSON 文件', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) {
        return { success: false, error: '用户取消' }
      }

      const report = getSessionReport(sessionId)
      // 直接读取文件导出完整数据
      const snapFile = path.join(storageDir, `${sessionId}.snapshots`)
      let exportData: Record<string, unknown>
      if (fs.existsSync(snapFile)) {
        exportData = {
          version: 1,
          tool: 'Electron Memory Monitor Tool',
          exportTime: new Date().toISOString(),
          session,
          report: report || null,
          snapshotsCount: session.snapshotCount,
          note: '完整的快照数据请查看原始 snapshots 文件',
        }
      } else {
        exportData = { session, report: report || null }
      }

      fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
      return { success: true, filePath: result.filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

// ============ 窗口创建 ============

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Electron Memory Monitor Tool',
    webPreferences: {
      preload: path.join(__dirname_electron, '../dist-electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ============ 应用生命周期 ============

app.whenReady().then(() => {
  ensureStorageDir()
  registerIpcHandlers()
  createMainWindow()

  const wsStatus = getNativeModuleStatus()
  console.log(
    `[MonitorTool] 专用工作集采集后端: ${wsStatus.backend}${wsStatus.error ? ` (${wsStatus.error})` : ''}`,
  )

  // 自动开始采集；测试会话由用户在界面「开始记录」或「启动并监控」创建
  startCollecting()

  app.on('activate', () => {
    if (!mainWindow) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  // 结束当前会话
  if (currentSession?.status === 'running') {
    endSession()
  }
  stopCollecting()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopCollecting()
  if (currentSession?.status === 'running') {
    endSession()
  }
})
