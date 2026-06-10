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
import { execFile, execSync, spawn, type ChildProcess } from 'child_process'
import {
  createPrivateWsProvider,
  getNativeModuleStatus,
  readExternalProcessMemoryNativeSync,
  enumerateProcessTreeNativeSync,
  gatherExternalMonitorSnapshotAsync,
  isNativeMemoryLoaded,
  batchGetProcessTimesAndIoSync,
  enumerateAllProcessesSync,
  type ExternalGatheredSnapshotPayload,
  type ExternalNativeMemoryRow,
  type NativeProcessTreeRow,
  type ProcessTimesIoRow,
  type SystemProcessListItem,
} from './native-memory'
import { fetchWindowsProcessTree } from './external-process-tree'
import { queryGpuSystemSnapshotCached } from './external-gpu-metrics'
import { perfChainMain, writeDiagNdjson, getDiagLogPath } from './diag-log'
import {
  getAutomationBaseUrl,
  getAutomationServerPort,
  startAutomationServer,
  stopAutomationServer,
  type AutomationStatus,
  type LaunchMonitorBody,
} from './automation-server'
import { runAutomationBatch, type AutomationBatchOptions, type AutomationBatchProgress } from './automation-batch'
import {
  computeResourceSummaryFromDataPoints,
  type ResourceSummaryPayload,
} from '../src/utils/reportResourceSummary'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

function getMonitorAppRoot(): string {
  return path.join(__dirname_electron, '..')
}

function resolveScenarioPath(scenarioPath: string): string {
  return path.isAbsolute(scenarioPath)
    ? scenarioPath
    : path.resolve(getMonitorAppRoot(), scenarioPath)
}

function toScenarioDisplayPath(absPath: string): string {
  const rel = path.relative(getMonitorAppRoot(), absPath)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/')
  }
  return absPath
}

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
    /** 专用已提交 KB（Win32 PrivateUsage / Chromium privateBytes） */
    privateBytes?: number
  }
}

interface MemorySnapshot {
  timestamp: number
  sessionId?: string
  seq: number
  processes: ProcessMemoryInfo[]
  totalWorkingSetSize: number
  /** 各进程专用已提交之和 (KB) */
  totalPrivateBytes?: number
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
/** AbortController：用于真正取消采集链（stopCollecting 时 abort，runCollectTickBody 检测到后立即退出） */
let collectAbortController: AbortController | null = null
/** 采集代次：stop/start 时递增，用于丢弃目标进程已退出后仍返回的迟到 tick */
let collectEpoch = 0
/** 每拍 Promise.race 的超时句柄，stop 时统一 clear，避免结束后 15s 仍打 COLLECT_TIMEOUT */
const pendingCollectTimeouts = new Set<ReturnType<typeof setTimeout>>()
/** 连续超时次数：达到 MAX_CONSECUTIVE_TIMEOUTS 自动结束会话 */
let consecutiveTimeoutCount = 0
/** 防止采集 tick 重叠（上一轮 native 未完成时又排入新 tick，主线程会卡死） */
let collectTickInFlight = false
const MAX_CONSECUTIVE_TIMEOUTS = 2
/** 防止 endSession 落盘期间 currentSession 仍为 running，导致超时 tick 重复进入 endSession */
let endSessionInProgress = false
/** 批量自动化是否进行中 */
let automationBatchRunning = false
let lastAutomationBatchProgress: AutomationBatchProgress | null = null
let batchActiveSessionLabel: string | null = null
let batchActiveCdpPort: number | null = null

function getAutomationStatusSnapshot(): AutomationStatus {
  const sessionRunning = currentSession?.status === 'running'
  const collecting = collectTimer != null
  const externalRootPid = monitoredRootPid ?? (externalPidsCache.length > 0 ? externalPidsCache[0] : null)
  const externalMonitor = externalRootPid != null
  return {
    sessionRunning,
    sessionId: currentSession?.id ?? null,
    sessionLabel: currentSession?.label ?? (automationBatchRunning ? batchActiveSessionLabel : null),
    collecting,
    externalMonitor,
    externalRootPid,
    monitorReady: sessionRunning && collecting && externalMonitor,
    batchRunning: automationBatchRunning,
    batchPhase: lastAutomationBatchProgress?.phase ?? null,
    batchMessage: lastAutomationBatchProgress?.message ?? null,
    batchRunIndex: lastAutomationBatchProgress?.runIndex ?? 0,
    batchTotalRuns: lastAutomationBatchProgress?.totalRuns ?? 0,
  }
}

function broadcastAutomationStatus(): void {
  broadcastToRenderer('automation:status', getAutomationStatusSnapshot())
}

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

/** 外部应用启动时持有的子进程句柄（shell 下多为已退出的 cmd，杀应用靠 monitoredRootPid + taskkill） */
let targetAppProcess: ChildProcess | null = null

/** Windows：被监控外部应用的根 PID（exec 子进程）；非空时快照改为采集该进程树 */
let monitoredRootPid: number | null = null
/** endSession/reset 会清 monitoredRootPid，杀进程时仍用此字段 taskkill 真实游戏根 PID */
let lastMonitoredRootPidForKill: number | null = null
/** 批量/调试端口：结束轮次后按端口再杀一次监听进程，避免第二轮 CDP 仍挂在旧 PID */
let lastCdpPortForKill: number | null = null
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

/** 结束会话 / 批量轮次间：重置采集运行时缓存，便于下一次附加或启动 */
function resetMonitorRuntimeState(): void {
  pendingMarks = []
  privateWsCache = new Map()
  privateWsLastRefresh = 0
  lastExternalPerfSample = null
  consecutiveTimeoutCount = 0
  collectTickChain = Promise.resolve()
}

function taskkillTreeAsync(pid: number): Promise<void> {
  if (process.platform !== 'win32' || pid <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

/** 结束目标应用进程树（launch 子进程或已附加的根 PID） */
async function killMonitoredTargetApp(): Promise<void> {
  const rootPid = monitoredRootPid ?? lastMonitoredRootPidForKill
  const pidsToKill = new Set<number>()
  if (rootPid != null && rootPid > 0) pidsToKill.add(rootPid)
  if (targetAppProcess && !targetAppProcess.killed) {
    const pid = targetAppProcess.pid
    if (typeof pid === 'number' && pid > 0) pidsToKill.add(pid)
    targetAppProcess = null
  }
  if (process.platform === 'win32' && lastCdpPortForKill != null) {
    const portPid = findPidListeningOnPort(lastCdpPortForKill)
    if (portPid != null) {
      console.log(`[MonitorTool] 按 CDP :${lastCdpPortForKill} 结束监听进程 PID=${portPid}`)
      pidsToKill.add(portPid)
    }
  }

  for (const pid of pidsToKill) {
    try {
      if (process.platform === 'win32') {
        await taskkillTreeAsync(pid)
      } else if (targetAppProcess && !targetAppProcess.killed) {
        targetAppProcess.kill()
      }
    } catch { /* ignore */ }
  }

  if (pidsToKill.size > 0) {
    console.log(`[MonitorTool] 已请求结束目标进程: ${[...pidsToKill].join(', ')}`)
  }
  await sleepMs(2000)
  if (process.platform === 'win32' && lastCdpPortForKill != null) {
    const freed = await waitForCdpPortFree(lastCdpPortForKill, 12_000)
    if (!freed) {
      console.warn(`[MonitorTool] CDP :${lastCdpPortForKill} 在 12s 内仍被占用，下一轮可能挂起或连到旧进程`)
    } else {
      console.log(`[MonitorTool] CDP :${lastCdpPortForKill} 已释放`)
    }
  }
  lastMonitoredRootPidForKill = null
  clearExternalMonitorState()
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function pathsEqualExe(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false
  try {
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  } catch {
    return a.toLowerCase() === b.toLowerCase()
  }
}

function snapshotAllProcessPids(): Set<number> {
  return new Set(enumerateAllProcessesSync().map((p) => p.pid))
}

function findProcessesByExe(appPath: string): SystemProcessListItem[] {
  return enumerateAllProcessesSync().filter((p) => p.exePath && pathsEqualExe(p.exePath, appPath))
}

function parseCdpPortFromArgs(args: string[]): number {
  for (const a of args) {
    const m = /^--remote-debugging-port=(\d+)$/i.exec(a.trim())
    if (m) return Math.max(1, parseInt(m[1], 10) || 9222)
  }
  return 9222
}

/** Windows：查谁在本机监听 CDP 端口（Electron 主进程通常就是内存监控根 PID） */
/** 轮询直到端口无 LISTENING 进程（批量下一轮启动前必须释放 9222） */
async function waitForCdpPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (findPidListeningOnPort(port) == null) return true
    await sleepMs(400)
  }
  return findPidListeningOnPort(port) == null
}

function findPidListeningOnPort(port: number, pidsBefore?: Set<number>): number | null {
  if (process.platform !== 'win32' || port <= 0) return null
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, {
      encoding: 'utf-8',
      windowsHide: true,
    })
    const listeners: number[] = []
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[parts.length - 1] ?? '', 10)
      if (!Number.isFinite(pid) || pid <= 0) continue
      if (pidsBefore && pidsBefore.has(pid)) continue
      listeners.push(pid)
    }
    if (listeners.length === 0) return null
    return Math.max(...listeners)
  } catch {
    return null
  }
}

function findNewProcessesInLaunchDir(appPath: string, pidsBefore: Set<number>): SystemProcessListItem[] {
  let launchDir = ''
  try {
    launchDir = path.dirname(path.resolve(appPath)).toLowerCase()
  } catch {
    return []
  }
  return enumerateAllProcessesSync().filter((p) => {
    if (pidsBefore.has(p.pid) || !p.exePath?.trim()) return false
    try {
      return path.dirname(path.resolve(p.exePath)).toLowerCase() === launchDir
    } catch {
      return false
    }
  })
}

function pickNewestProcess(candidates: SystemProcessListItem[]): number | null {
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.pid - a.pid)
  return candidates[0].pid
}

interface WindowsLaunchResult {
  method: string
  hintedPid?: number
}

/**
 * 启动被测应用时不能继承监控工具 dev 进程的环境变量。
 * 否则会带上 VITE_DEV_SERVER_URL=http://localhost:3900 等，目标 Electron 误加载本工具页面而黑屏。
 */
function buildTargetAppEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const stripped: string[] = []
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('VITE_')
      || key.startsWith('ELECTRON_RENDERER_')
      || key === 'ELECTRON_RUN_AS_NODE'
      || key === 'NODE_ENV' && env[key] === 'development'
    ) {
      stripped.push(key)
      delete env[key]
    }
  }
  if (stripped.length > 0) {
    console.log('[MonitorTool] 已剥离子进程环境变量:', stripped.join(', '))
  }
  return env
}

/**
 * Electron 发行包常把 exe 放在版本子目录，resources 在更上层。
 * 从 exe 向上找含 resources 的目录作为 cwd，避免目标应用黑屏（找不到 asar/静态资源）。
 */
function resolveLaunchCwd(appPath: string): string {
  const exeDir = path.dirname(path.resolve(appPath))
  let dir = exeDir
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'resources'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return exeDir
}

/**
 * 启动被测应用：Windows 下用 detached spawn 直启 exe（等同 CreateProcess，不经 cmd/PowerShell 包一层）。
 * PowerShell/cmd start 对部分平台启动器会导致子进程环境/工作目录不对，目标应用会黑屏。
 */
function launchTargetDetached(appPath: string, args: string[]): WindowsLaunchResult {
  if (!fs.existsSync(appPath)) {
    throw new Error(`应用不存在: ${appPath}`)
  }

  const cwd = resolveLaunchCwd(appPath)
  const exeDir = path.dirname(path.resolve(appPath))
  if (appPath.replace(/\\/g, '/').toLowerCase().includes('/node_modules/')) {
    console.warn(
      '[MonitorTool] 警告: 应用路径在 node_modules 内，可能不是正式安装入口。'
      + ' 请选平台安装目录下的启动器（如 platform-launcher.exe 或开始菜单快捷方式指向的 exe）',
    )
  }
  const absExe = path.resolve(appPath)
  if (cwd !== exeDir) {
    console.log(`[MonitorTool] 启动 cwd=${cwd}（exe 目录 ${exeDir}）`)
  }
  console.log('[MonitorTool] 即将执行 exe:', absExe)
  console.log('[MonitorTool] 启动参数:', args.join(' ') || '(无)')

  const child = spawn(absExe, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: buildTargetAppEnv(),
  })
  child.unref()
  targetAppProcess = child
  child.on('exit', () => {
    if (targetAppProcess === child) targetAppProcess = null
  })
  const hintedPid = typeof child.pid === 'number' && child.pid > 0 ? child.pid : undefined
  return { method: 'detached-spawn', hintedPid }
}

async function waitForLaunchedRootPid(
  appPath: string,
  pidsBefore: Set<number>,
  timeoutMs: number,
  cdpPort: number,
  onStatus?: (message: string) => void,
  hintedPid?: number,
): Promise<{ pid: number; via: string } | null> {
  const report = (message: string) => {
    console.log(`[MonitorTool] ${message}`)
    onStatus?.(message)
  }
  const deadline = Date.now() + timeoutMs
  let lastLogAt = 0

  const tryHintedPid = (): number | null => {
    if (hintedPid == null || hintedPid <= 0) return null
    const proc = enumerateAllProcessesSync().find((p) => p.pid === hintedPid)
    if (proc) return hintedPid
    return null
  }

  while (Date.now() < deadline) {
    const hint = tryHintedPid()
    if (hint != null && !pidsBefore.has(hint)) {
      report(`已使用启动返回的 PID=${hint}`)
      return { pid: hint, via: 'launch-hint' }
    }

    const freshExact = findProcessesByExe(appPath).filter((p) => !pidsBefore.has(p.pid))
    const exactPid = pickNewestProcess(freshExact)
    if (exactPid != null) {
      report(`已匹配启动 exe PID=${exactPid}`)
      return { pid: exactPid, via: 'exe-path' }
    }

    const freshInDir = findNewProcessesInLaunchDir(appPath, pidsBefore)
    const dirPid = pickNewestProcess(freshInDir)
    if (dirPid != null) {
      report(`已匹配安装目录新进程 PID=${dirPid}（启动器可能拉起子进程）`)
      return { pid: dirPid, via: 'launch-dir' }
    }

    const portPid = findPidListeningOnPort(cdpPort, pidsBefore)
    if (portPid != null) {
      report(`已匹配 CDP :${cdpPort} 监听进程 PID=${portPid}`)
      return { pid: portPid, via: 'cdp-port' }
    }

    const now = Date.now()
    if (now - lastLogAt >= 5000) {
      const elapsed = Math.round((now - (deadline - timeoutMs)) / 1000)
      report(`等待目标进程… ${elapsed}s（exe 路径 / 同目录 / CDP :${cdpPort}）`)
      lastLogAt = now
    }
    await sleepMs(500)
  }

  const portPid = findPidListeningOnPort(cdpPort)
  if (portPid != null) {
    report(`超时后仍发现 CDP :${cdpPort} 监听 PID=${portPid}`)
    return { pid: portPid, via: 'cdp-port-late' }
  }
  const anyExact = pickNewestProcess(findProcessesByExe(appPath))
  if (anyExact != null) {
    report(`超时后回退到已有 exe 实例 PID=${anyExact}`)
    return { pid: anyExact, via: 'exe-fallback' }
  }
  return null
}

/** CDP 端口就绪后，用监听该端口的进程作为监控根 PID（比启动器 PID 更准） */
async function waitAndSyncRootPidFromCdp(
  cdpPort: number,
  fallbackAppPath: string,
  fallbackAppName: string,
  timeoutMs: number,
  onStatus?: (message: string) => void,
): Promise<number | null> {
  const report = (msg: string) => {
    console.log(`[MonitorTool] ${msg}`)
    onStatus?.(msg)
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cdpPid = findPidListeningOnPort(cdpPort)
    if (cdpPid != null) {
      const proc = enumerateAllProcessesSync().find((p) => p.pid === cdpPid)
      const resolvedPath = proc?.exePath?.trim() || fallbackAppPath
      const resolvedName = proc?.name?.trim() || fallbackAppName
      report(`CDP :${cdpPort} 监听 PID=${cdpPid}，已同步为监控根`)
      if (targetAppInfo) {
        targetAppInfo.appPath = resolvedPath
        targetAppInfo.appName = path.basename(resolvedPath).replace(/\.(exe|app|bat|sh)$/i, '') || resolvedName
      }
      applyLaunchedRootPid(cdpPid, resolvedPath, resolvedName)
      consecutiveTimeoutCount = 0
      broadcastAutomationStatus()
      return cdpPid
    }
    await sleepMs(500)
  }
  return null
}

/** 批量自动化期间确保会话、采集、外部 PID 均就绪（采集超时时也会调用） */
async function ensureBatchMonitorActive(cdpPort: number, sessionLabel: string): Promise<void> {
  const appPath = targetAppInfo?.appPath ?? ''
  const appName = targetAppInfo?.appName ?? 'app'
  if (monitoredRootPid == null || externalPidsCache.length === 0) {
    await waitAndSyncRootPidFromCdp(cdpPort, appPath, appName, 15_000)
  }
  if (currentSession?.status !== 'running') {
    await startSession(sessionLabel, `批量自动化: ${appPath}`)
  } else if (collectTimer == null) {
    startCollecting()
  }
  broadcastAutomationStatus()
}

function applyLaunchedRootPid(childPid: number, appPath: string, appName: string): void {
  const proc = enumerateAllProcessesSync().find((p) => p.pid === childPid)
  const resolvedExe = proc?.exePath?.trim() || appPath
  const resolvedName = proc?.name?.trim() || appName
  privateWsCache = new Map()
  privateWsLastRefresh = 0
  lastExternalPerfSample = null
  externalTotalExcludedPids = new Set()
  externalPidsCache = [childPid]
  externalNamesCache = new Map([[childPid, resolvedName]])
  externalExePathCache = new Map([[childPid, resolvedExe]])
  externalCommandLineCache = new Map()
  externalTreeLastRefresh = 0
  lastMonitoredRootPidForKill = childPid
  if (isNativeMemoryLoaded()) {
    monitoredRootPid = childPid
    syncExternalProcessTreeFromNative(childPid)
    perfChainMain('launchTargetApp_tree_applied', {
      rootPid: childPid,
      pidCount: externalPidsCache.length,
    })
  } else {
    monitoredRootPid = childPid
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
      broadcastAutomationStatus()
    })
  }
  broadcastAutomationStatus()
}

/** 仅清理外部进程树状态，不启停采集定时器 */
function clearExternalMonitorState(): void {
  monitoredRootPid = null
  externalPidsCache = []
  externalNamesCache = new Map()
  externalExePathCache = new Map()
  externalCommandLineCache = new Map()
  externalTotalExcludedPids = new Set()
  externalTreeLastRefresh = 0
  lastExternalPerfSample = null
  targetAppInfo = null
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
 * - 镜像路径与启动 exe **完全相同**（Chromium/CEF 系子进程多为同一 GameClient.exe + 不同 --type）；
 * - 或镜像文件名与启动 exe **相同**（同目录换盘等边缘情况）；
 * - 或命令行中出现启动 exe 的**完整规范化路径**（兼容 / 与 \\）。
 *
 * 刻意**不再**使用「仅同安装目录」规则，否则会误留同目录下的 updater.exe、patch_worker.exe 等辅助进程。
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

    // 与启动器同一物理镜像（任务管理器里 gpu/renderer 等多为同一 GameClient.exe）
    if (exeNorm === launchNorm) return true
    // 同目录下同文件名（避免仅 basename 相同但路径无关的误匹配）
    if (exeBase === launchBase && exeNorm.startsWith(launchDirPrefix)) return true

    // 命令行里带完整启动路径（如 "...GameClient.exe" --type=gpu-process）
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
  if (monitoredRootPid == null && list.length > 0) {
    monitoredRootPid = rootPid
  }
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

function queueEventMark(label: string, metadata?: Record<string, unknown>): void {
  const trimmed = label.trim()
  if (!trimmed) return
  pendingMarks.push({
    timestamp: Date.now(),
    label: trimmed,
    metadata,
  })
}

function getPrivateBytesKB(mem: ProcessMemoryInfo['memory']): number {
  if (mem.privateBytes != null && mem.privateBytes > 0) return mem.privateBytes
  return mem.privateWorkingSet ?? mem.workingSetSize
}

function sumPrivateBytesKB(processes: ProcessMemoryInfo[], includedPids?: number[]): number {
  const included = includedPids ? new Set(includedPids) : null
  return processes
    .filter((p) => !included || included.has(p.pid))
    .reduce((sum, p) => sum + getPrivateBytesKB(p.memory), 0)
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
  utilityKB: number
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
    const utilityKB = s.processes
      .filter((p) => p.type === 'Utility')
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
        utilityKB,
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
      privateBytes: (m.memory as unknown as Record<string, number>).privateBytes,
    },
  }))

  const totalWorkingSetSize = processes.reduce(
    (sum, p) => sum + getEffectiveMemoryKB(p.memory),
    0,
  )
  const totalPrivateBytes = sumPrivateBytesKB(processes)

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
    totalPrivateBytes,
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
    const privateBytesKb = row?.privateBytesKb ?? 0
    const wsKb = row?.workingSetKb ?? 0
    const peakKb = row?.peakKb ?? wsKb
    const isRoot = pid === root
    const exe = externalExePathCache.get(pid)
    const cmd = externalCommandLineCache.get(pid)
    const r = rates.get(pid)
    const chromiumRole = parseChromiumProcessRole(cmd)
    // 根据命令行 --type= 推断进程类型（不再把非根进程全部当 Tab）
    const inferredType: ProcessMemoryInfo['type'] = isRoot
      ? 'Browser'
      : (function (): ProcessMemoryInfo['type'] {
          if (!chromiumRole) return 'Tab'
          const t = chromiumRole.split(':')[0]?.toLowerCase() ?? ''
          if (t === 'gpu-process') return 'GPU'
          if (t === 'utility') return 'Utility'
          if (t === 'renderer') return 'Tab'
          // Zygote / crashpad-handler 等归入 Utility 展示
          return 'Utility'
        })()
    return {
      pid,
      type: inferredType,
      name: externalNamesCache.get(pid),
      executablePath: exe,
      commandLine: cmd,
      chromiumType: chromiumRole,
      cpu: { percentCPUUsage: r?.cpuPct ?? 0, idleWakeupsPerSecond: 0 },
      diskReadKBps: r?.readKBps ?? 0,
      diskWriteKBps: r?.writeKBps ?? 0,
      memory: {
        workingSetSize: wsKb,
        peakWorkingSetSize: peakKb,
        privateWorkingSet: privKb,
        privateBytes: privateBytesKb > 0 ? privateBytesKb : undefined,
      },
    }
  }).sort((a, b) => getEffectiveMemoryKB(b.memory) - getEffectiveMemoryKB(a.memory))

  const includedPids = displayPids.filter((pid) => !externalTotalExcludedPids.has(pid))
  const totalWorkingSetSize = processes
    .filter((p) => includedPids.includes(p.pid))
    .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
  const totalPrivateBytes = sumPrivateBytesKB(processes, includedPids)

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
    totalPrivateBytes,
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
  const root = monitoredRootPid
  if (root == null) throw new Error('COLLECT_ABORTED')

  const timestamp = Date.now()
  const gathered: ExternalGatheredSnapshotPayload | null = await gatherExternalMonitorSnapshotAsync(root)

  if (monitoredRootPid == null) throw new Error('COLLECT_ABORTED')

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

interface StartSessionOptions {
  /** 默认 true；launch 流程中先开会话、再附加 PID，应传 false 避免与同步快照争抢 native */
  autoCollect?: boolean
}

async function startSession(
  label: string,
  description?: string,
  options?: StartSessionOptions,
): Promise<TestSession> {
  const autoCollect = options?.autoCollect !== false
  // 如果有正在运行的会话，先结束它（须 await，否则新会话可能在旧会话落盘前开始）
  if (currentSession && currentSession.status === 'running') {
    await endSession()
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

  if (autoCollect) {
    startCollecting()
  }

  perfChainMain('startSession', { sessionId: session.id, label, autoCollect })
  console.log(`[MonitorTool] Session started: ${label} (${session.id})`)
  broadcastAutomationStatus()
  return session
}

/** 异步落盘：避免巨量 writeFileSync 长时间霸占主线程，其它 IPC（如拉取报告）可穿插执行 */
async function endSession(): Promise<TestSession | null> {
  if (!currentSession || currentSession.status !== 'running') return null
  if (endSessionInProgress) {
    console.log('[MonitorTool] endSession skipped (already in progress)')
    return null
  }

  endSessionInProgress = true
  try {
    stopCollecting()
    clearExternalMonitorState()
    resetMonitorRuntimeState()

    const endedRef = currentSession
    const buffer = [...snapshotsBuffer]
    const endTime = Date.now()

    // 落盘前立即标记结束，避免在途 tick 超时再次调用 endSession（collectEpoch 连跳、停不下来）
    endedRef.status = 'completed'
    endedRef.endTime = endTime
    currentSession = null
    snapshotsBuffer = []

    const idx = sessionsIndex.findIndex((s) => s.id === endedRef.id)
    if (idx >= 0) {
      sessionsIndex[idx].status = 'completed'
      sessionsIndex[idx].endTime = endTime
    }
    saveSessionsIndex()

    let report: ReportSummary
    try {
      const sessionDataFile = path.join(storageDir, endedRef.dataFile)
      const lines = buffer.map((s) => JSON.stringify(s))
      await fs.promises.writeFile(sessionDataFile, lines.join('\n'), 'utf-8')
      report = generateReportSummary(endedRef, buffer)
      await fs.promises.writeFile(
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
          endTime,
          durationMs: 0,
          snapshotCount: buffer.length,
          summary: {
            peakTotalMB: 0,
            avgTotalMB: 0,
            finalTotalMB: 0,
            peakBrowserMB: 0,
            peakRendererMB: 0,
            peakUtilityMB: 0,
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

    endedRef.snapshotCount = buffer.length

    saveSessionsIndex()

    broadcastToRenderer('session:ended', { session: endedRef, report })

    console.log(`[MonitorTool] Session ended: ${endedRef.label}`)
    broadcastAutomationStatus()
    return endedRef
  } finally {
    endSessionInProgress = false
  }
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
    /** 辅助进程峰值 (MB) */
    peakUtilityMB: number
    /** 进程数峰值 */
    peakProcessCount: number
    /** 专用已提交峰值 (MB) */
    peakTotalPrivateBytesMB?: number
    /** 专用已提交均值 (MB) */
    avgTotalPrivateBytesMB?: number
    /** 专用已提交末值 (MB) */
    finalTotalPrivateBytesMB?: number
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
    /** 专用已提交合计 (MB) */
    totalPrivateBytesMB?: number
    browserMB: number
    rendererMB: number
    gpuMB: number
    utilityMB: number
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
      summary: {
        peakTotalMB: 0, avgTotalMB: 0, finalTotalMB: 0,
        peakBrowserMB: 0, peakRendererMB: 0, peakUtilityMB: 0, peakProcessCount: 0,
        peakTotalPrivateBytesMB: 0, avgTotalPrivateBytesMB: 0, finalTotalPrivateBytesMB: 0,
      },
      trendAnalysis: { hasGrowthTrend: false, growthRatePerMin: 0, growthAmountMB: 0, conclusion: 'PASS', reason: '无数据' },
      dataPoints: [],
      eventMarks: [],
    }
  }

  // 计算各指标
  let peakTotal = 0
  let sumTotal = 0
  let peakTotalPrivateBytes = 0
  let sumTotalPrivateBytes = 0
  let peakBrowser = 0
  let peakRenderer = 0
  let peakUtility = 0
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
    const utilityMem = s.processes
      .filter((p) => p.type === 'Utility')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)

    const totalMB = Math.round(s.totalWorkingSetSize / 1024 * 10) / 10
    const totalPrivateBytesKB = s.totalPrivateBytes ?? sumPrivateBytesKB(
      s.processes,
      s.externalTotalIncludedPids,
    )
    const totalPrivateBytesMB = Math.round(totalPrivateBytesKB / 1024 * 10) / 10
    const browserMB = Math.round(browserMem / 1024 * 10) / 10
    const rendererMB = Math.round(rendererMem / 1024 * 10) / 10
    const gpuMB = Math.round(gpuMem / 1024 * 10) / 10
    const utilityMB = Math.round(utilityMem / 1024 * 10) / 10

    peakTotal = Math.max(peakTotal, s.totalWorkingSetSize)
    sumTotal += s.totalWorkingSetSize
    peakTotalPrivateBytes = Math.max(peakTotalPrivateBytes, totalPrivateBytesKB)
    sumTotalPrivateBytes += totalPrivateBytesKB
    peakBrowser = Math.max(peakBrowser, browserMem)
    peakRenderer = Math.max(peakRenderer, rendererMem)
    peakUtility = Math.max(peakUtility, utilityMem)
    peakProcCount = Math.max(peakProcCount, s.processes.length)

    const pt: ReportSummary['dataPoints'][number] = {
      timestamp: s.timestamp,
      totalMB,
      totalPrivateBytesMB,
      browserMB,
      rendererMB,
      gpuMB,
      utilityMB,
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
      peakUtilityMB: Math.round(peakUtility / 1024 * 10) / 10,
      peakProcessCount: peakProcCount,
      peakTotalPrivateBytesMB: Math.round(peakTotalPrivateBytes / 1024 * 10) / 10,
      avgTotalPrivateBytesMB: Math.round(sumTotalPrivateBytes / snapshots.length / 1024 * 10) / 10,
      finalTotalPrivateBytesMB: dataPoints[dataPoints.length - 1].totalPrivateBytesMB ?? 0,
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

/** 单次采集 tick 的最大执行时间（ms），超后丢弃该拍并继续下一拍，避免外部进程退出时 native hang 导致整条链死锁 */
const COLLECT_TICK_TIMEOUT_MS = 15000

function clearPendingCollectTimeouts(): void {
  for (const id of pendingCollectTimeouts) clearTimeout(id)
  pendingCollectTimeouts.clear()
}

function bumpCollectEpoch(): void {
  collectEpoch += 1
}

function isCollectTickStale(epochAtStart: number): boolean {
  return epochAtStart !== collectEpoch || collectTimer == null
}

function enqueueCollectTick(): void {
  if (!collectTimer || !collectAbortController || collectAbortController.signal.aborted) return
  collectTickChain = collectTickChain
    .then(() => runCollectTickBody())
    .catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('COLLECT_ABORTED') || errMsg.includes('COLLECT_TIMEOUT')) return
      console.error('[MonitorTool] collect tick failed:', err)
    })
}

async function runCollectTickBody(): Promise<void> {
  const epochAtStart = collectEpoch
  if (isCollectTickStale(epochAtStart)) return
  if (collectTickInFlight) {
    perfChainMain('collect_tick_skipped', { reason: 'previous tick still in flight', collectEpoch })
    return
  }
  collectTickInFlight = true

  const now = Date.now()
  const driftMs = lastCollectScheduledAt ? now - lastCollectScheduledAt - CONFIG.collectInterval : 0
  lastCollectScheduledAt = now
  const b0 = Date.now()

  if (collectAbortController?.signal.aborted || isCollectTickStale(epochAtStart)) {
    console.log('[MonitorTool] collect tick aborted, skipping')
    return
  }

  const abortPromise = new Promise<MemorySnapshot>((_, reject) => {
    const ctrl = collectAbortController
    if (!ctrl?.signal) return
    const onAbort = () => reject(new Error('COLLECT_ABORTED'))
    if (ctrl.signal.aborted) onAbort()
    else ctrl.signal.addEventListener('abort', onAbort, { once: true })
  })

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<MemorySnapshot>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`COLLECT_TIMEOUT after ${COLLECT_TICK_TIMEOUT_MS}ms`)),
      COLLECT_TICK_TIMEOUT_MS,
    )
    pendingCollectTimeouts.add(timeoutId)
  })

  try {
    const snapshot = await Promise.race([buildSnapshotAsync(), abortPromise, timeoutPromise])

    if (isCollectTickStale(epochAtStart)) return

    consecutiveTimeoutCount = 0

    const buildMs = Date.now() - b0
    perfChainMain('collect_tick', {
      driftMs,
      buildMs,
      seq: snapshot.seq,
      monitorMode: snapshot.monitorMode ?? 'self',
      procCount: snapshot.processes.length,
    })
    pushSnapshot(snapshot)
  } catch (err) {
    if (isCollectTickStale(epochAtStart)) return

    const errMsg = err instanceof Error ? err.message : String(err)

    if (errMsg.includes('COLLECT_ABORTED')) {
      console.log('[MonitorTool] collect tick aborted via AbortController')
      return
    }

    if (errMsg.includes('COLLECT_TIMEOUT') || errMsg.includes('GATHER_TIMEOUT')) {
      if (endSessionInProgress || currentSession?.status !== 'running') {
        console.log('[MonitorTool] collect tick timeout ignored (session not active)')
        return
      }
      consecutiveTimeoutCount++
      console.error(`[MonitorTool] collect tick timeout (${consecutiveTimeoutCount}/${MAX_CONSECUTIVE_TIMEOUTS})`)

      if (consecutiveTimeoutCount >= MAX_CONSECUTIVE_TIMEOUTS) {
        if (automationBatchRunning) {
          console.warn('[MonitorTool] 批量自动化采集超时，重同步监控（不自动结束会话）')
          const port = batchActiveCdpPort ?? 9222
          const label = batchActiveSessionLabel ?? 'auto-batch'
          await ensureBatchMonitorActive(port, label)
          consecutiveTimeoutCount = 0
          return
        }
        console.warn('[MonitorTool] 连续超时 2 次，自动结束会话')
        await endSession()
      }
      return
    }

    consecutiveTimeoutCount = 0
    throw err
  } finally {
    collectTickInFlight = false
    if (timeoutId != null) {
      clearTimeout(timeoutId)
      pendingCollectTimeouts.delete(timeoutId)
    }
  }
}

/** 强制重置采集串行链（目标进程已退出、重新附加前调用） */
function forceResetCollectChain(): void {
  tearDownCollectScheduler()
  consecutiveTimeoutCount = 0
  collectTickInFlight = false
  console.warn('[MonitorTool] forceResetCollectChain: 已停止采集并丢弃在途 tick')
}

/** 拆除定时器 / abort / 代次；不打印「已停止」（供 startCollecting 重启调度，避免误报） */
function tearDownCollectScheduler(): void {
  if (collectTimer) {
    clearInterval(collectTimer)
    collectTimer = null
  }
  clearPendingCollectTimeouts()
  if (collectAbortController) {
    try { collectAbortController.abort() } catch { /* ignore */ }
    collectAbortController = null
  }
  bumpCollectEpoch()
  collectTickChain = Promise.resolve()
}

function startCollecting(): void {
  tearDownCollectScheduler()

  collectAbortController = new AbortController()
  consecutiveTimeoutCount = 0

  initPrivateWsRefreshInterval()

  lastCollectScheduledAt = Date.now()
  collectTimer = setInterval(() => {
    enqueueCollectTick()
  }, CONFIG.collectInterval)

  enqueueCollectTick()

  console.log('[MonitorTool] Collection started, interval:', CONFIG.collectInterval, 'ms')
  perfChainMain('startCollecting', {
    intervalMs: CONFIG.collectInterval,
    collectEpoch,
    note: '单一定时器；每 interval 仅 buildSnapshot 一次 + pushSnapshot',
  })
}

function stopCollecting(): void {
  const wasActive = collectTimer != null || collectAbortController != null
  tearDownCollectScheduler()
  consecutiveTimeoutCount = 0
  if (wasActive) {
    console.log('[MonitorTool] Collection stopped')
    perfChainMain('stopCollecting', {
      collectEpoch,
      note: 'session ended or user stopped; no further collect_tick expected',
    })
  }
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
  const sessionActive = currentSession?.status === 'running'
  if (!sessionActive) return

  snapshotsBuffer.push(snapshot)

  let diskWriteMs = 0
  const sessionDataFile = path.join(storageDir, currentSession!.dataFile)
  try {
    const d0 = Date.now()
    fs.appendFileSync(sessionDataFile, JSON.stringify(snapshot) + '\n', 'utf-8')
    diskWriteMs = Date.now() - d0
    currentSession!.snapshotCount++
  } catch (err) {
    console.error('[MonitorTool] Failed to write snapshot:', err)
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

// ============ 附加到已有进程（替代启动 exe） ============

interface AttachResult {
  success: boolean
  error?: string
  info?: { pid: number; appName: string; exePath: string }
  session?: TestSession
}

/**
 * 附加到系统中已运行的进程进行监控。
 * 与 launchTargetApp 的区别：不启动子进程，直接以目标 PID 为根枚举进程树。
 */
async function attachToProcess(pid: number, processInfo: SystemProcessListItem, customLabel?: string): Promise<AttachResult> {
  perfChainMain('attachToProcess_begin', { pid })
  try {
    if (!isNativeMemoryLoaded()) {
      return { success: false, error: 'C++ 原生模块未加载，无法附加监控。请执行 build:with-native 后重试。' }
    }

    // 目标进程可能已先退出：必须先停采集并清外部状态，否则 native gather 会卡住无法开始新会话
    if (endSessionInProgress) {
      return { success: false, error: '正在结束上一会话，请稍后再附加' }
    }
    tearDownCollectScheduler()
    resetMonitorRuntimeState()
    clearExternalMonitorState()
    consecutiveTimeoutCount = 0

    const appName = processInfo.name || `PID_${pid}`
    const exePath = processInfo.exePath || ''

    targetAppInfo = {
      appName,
      appPath: exePath,
      startTime: new Date(), // 记录为"发现时间"而非启动时间
    }

    // 不再持有 execFile 子进程句柄 — 目标进程是外部的，退出由用户感知
    targetAppProcess = null

    // 设置根 PID 并立即枚举子树
    monitoredRootPid = pid
    lastMonitoredRootPidForKill = pid
    privateWsCache = new Map()
    privateWsLastRefresh = 0
    lastExternalPerfSample = null
    externalTotalExcludedPids = new Set()
    externalPidsCache = [pid]
    externalNamesCache = new Map([[pid, appName]])
    externalExePathCache = new Map([[pid, exePath]])
    externalCommandLineCache = new Map()
    externalTreeLastRefresh = 0

    // 同步枚举进程树
    syncExternalProcessTreeFromNative(pid)
    perfChainMain('attachToProcess_tree_applied', {
      rootPid: pid,
      pidCount: externalPidsCache.length,
    })

    // 自动新建测试会话（优先使用用户自定义名称）
    const sessionLabel = customLabel?.trim() || `附加: ${appName} (PID ${pid})`
    const session = await startSession(
      sessionLabel,
      `已运行进程: ${exePath || '未知路径'} (PID=${pid})`,
      { autoCollect: false },
    )
    perfChainMain('attachToProcess_resolve', {
      sessionId: session.id,
      attachedPid: pid,
      collectIntervalMs: CONFIG.collectInterval,
    })

    startCollecting()
    void buildSnapshotAsync()
      .then((immediateSnap) => {
        pushSnapshot(immediateSnap)
        console.log('[MonitorTool] attachToProcess: immediate snapshot pushed, seq=', immediateSnap.seq)
      })
      .catch((snapErr) => {
        console.error('[MonitorTool] attachToProcess: immediate async snapshot failed:', snapErr)
      })

    return { success: true, info: { pid, appName, exePath }, session }
  } catch (err) {
    console.error('[MonitorTool] Failed to attach to process:', err)
    targetAppInfo = null
    clearExternalMonitorState()
    return { success: false, error: String(err) }
  }
}

// ============ 外部应用启动 ============

interface LaunchAppResult {
  success: boolean
  error?: string
  info?: { appPath: string; appName: string }
  session?: TestSession
}

async function launchTargetApp(
  appPath: string,
  args: string[],
  customSessionLabel?: string,
  onLaunchStatus?: (message: string) => void,
): Promise<LaunchAppResult> {
  perfChainMain('launchTargetApp_begin', { appPath })
  try {
    collectTickChain = Promise.resolve()

    const appName = path.basename(appPath).replace(/\.(exe|app|bat|sh)$/, '')
    targetAppInfo = {
      appName,
      appPath,
      startTime: new Date(),
    }

    let childPid: number | null = null

    if (process.platform === 'win32') {
      const pidsBefore = snapshotAllProcessPids()
      const cdpPort = parseCdpPortFromArgs(args)
      let launchResult: WindowsLaunchResult
      try {
        launchResult = launchTargetDetached(appPath, args)
      } catch (e) {
        targetAppInfo = null
        clearExternalMonitorState()
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
      onLaunchStatus?.(`已用 ${launchResult.method} 启动，等待目标进程…`)
      const resolved = await waitForLaunchedRootPid(
        appPath,
        pidsBefore,
        90_000,
        cdpPort,
        onLaunchStatus,
        launchResult.hintedPid,
      )
      if (resolved == null) {
        targetAppInfo = null
        clearExternalMonitorState()
        return {
          success: false,
          error:
            '启动命令已执行，但 90s 内未找到目标进程。'
            + ' 请确认游戏窗口是否弹出；若启动器会拉起子进程，可手动启动后用「附加到进程」。'
            + ` 或执行 pnpm scenario:check-cdp 检查 CDP :${cdpPort}`,
        }
      }
      childPid = resolved.pid
      console.log(`[MonitorTool] Windows launch resolved root PID: ${childPid} (via ${resolved.via})`)
      const proc = enumerateAllProcessesSync().find((p) => p.pid === childPid)
      if (proc?.exePath?.trim() && targetAppInfo) {
        targetAppInfo.appPath = proc.exePath.trim()
        targetAppInfo.appName = path.basename(proc.exePath).replace(/\.(exe|app|bat|sh)$/i, '')
      }
    } else {
      childPid = await new Promise<number | null>((resolve) => {
        const execOpts = {
          cwd: path.dirname(appPath),
          env: buildTargetAppEnv(),
          stdio: ['ignore', 'pipe', 'pipe'] as const,
        } as Parameters<typeof execFile>[2]
        targetAppProcess = execFile(path.resolve(appPath), args, execOpts, (err) => {
          console.log(
            `[MonitorTool] Target app exited`,
            err ? `code=${(err as NodeJS.ErrnoException).code ?? '?'}` : 'ok',
          )
          targetAppProcess = null
          targetAppInfo = null
          if (currentSession?.status === 'running') {
            void endSession()
          }
          clearExternalMonitorState()
        })
        targetAppProcess.stderr?.on('data', (data: Buffer) => {
          console.log(`[TargetApp][stderr]: ${data.toString().trim()}`)
        })
        const pid = targetAppProcess.pid
        resolve(typeof pid === 'number' && pid > 0 ? pid : null)
      })
      if (childPid == null) {
        targetAppProcess = null
        targetAppInfo = null
        clearExternalMonitorState()
        return { success: false, error: '无法获取目标进程 PID' }
      }
    }

    applyLaunchedRootPid(childPid, appPath, appName)

    const cdpPortForSession = parseCdpPortFromArgs(args)
    const needsCdp = args.some((a) => /^--remote-debugging-port=/i.test(a.trim()))
    if (needsCdp && process.platform === 'win32') {
      onLaunchStatus?.(`等待 CDP :${cdpPortForSession} 就绪后再开会话…`)
      const synced = await waitAndSyncRootPidFromCdp(
        cdpPortForSession,
        targetAppInfo?.appPath ?? appPath,
        targetAppInfo?.appName ?? appName,
        90_000,
        onLaunchStatus,
      )
      if (synced == null) {
        targetAppInfo = null
        clearExternalMonitorState()
        return {
          success: false,
          error: `CDP :${cdpPortForSession} 在 90s 内未就绪，无法附加监控。请确认调试端口已传到带窗口的进程`,
        }
      }
      childPid = synced
    }

    const sessionLabel = customSessionLabel ?? `启动: ${appName}`
    if (automationBatchRunning) {
      batchActiveSessionLabel = sessionLabel
      batchActiveCdpPort = needsCdp ? cdpPortForSession : null
      if (needsCdp) lastCdpPortForKill = cdpPortForSession
    }

    const session = await startSession(
      sessionLabel,
      `可执行文件: ${targetAppInfo?.appPath ?? appPath}`,
      { autoCollect: false },
    )
    perfChainMain('launchTargetApp_resolve', {
      sessionId: session.id,
      childPid,
      collectIntervalMs: CONFIG.collectInterval,
    })

    startCollecting()
    void buildSnapshotAsync()
      .then((immediateSnap) => {
        pushSnapshot(immediateSnap)
        console.log('[MonitorTool] launchTargetApp: immediate snapshot pushed, seq=', immediateSnap.seq)
      })
      .catch((snapErr) => {
        console.error('[MonitorTool] launchTargetApp: immediate async snapshot failed:', snapErr)
      })

    return { success: true, info: { appPath, appName }, session }
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
  ipcMain.handle('session:start', (_e, label: string, desc?: string) => startSession(label, desc))

  ipcMain.handle('session:stop', async () => {
    try {
      const waitDeadline = Date.now() + 60_000
      while (endSessionInProgress && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (endSessionInProgress) {
        console.warn('[MonitorTool] session:stop: endSession 仍在进行，强制重置采集状态')
        stopCollecting()
        resetMonitorRuntimeState()
        clearExternalMonitorState()
        currentSession = null
        snapshotsBuffer = []
        endSessionInProgress = false
        broadcastToRenderer('session:ended', { session: null, report: null })
        return null
      }
      if (currentSession?.status === 'running') {
        return await endSession()
      }
      // 无运行中的会话时也要清理外部监控状态 + 停止残留定时器
      stopCollecting()
      clearExternalMonitorState()
      healStaleRunningSessionsInIndex('结束会话时主进程无活动会话')
      broadcastToRenderer('session:ended', { session: null, report: null })
      return null
    } catch (err) {
      console.error('[MonitorTool] session:stop 异常:', err)
      stopCollecting()
      clearExternalMonitorState()
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
    queueEventMark(label, metadata)
    return true
  })

  ipcMain.handle('automation:get-info', () => ({
    baseUrl: getAutomationBaseUrl(),
    port: getAutomationServerPort(),
  }))

  ipcMain.handle('automation:get-status', (): AutomationStatus => getAutomationStatusSnapshot())

  ipcMain.handle('automation:run-batch', async (_e, opts: AutomationBatchOptions) => {
    if (automationBatchRunning) {
      return { ok: false, error: '批量自动化正在进行中' }
    }
    if (!opts?.appPath?.trim()) {
      return { ok: false, error: '请提供 appPath' }
    }
    automationBatchRunning = true
    batchActiveSessionLabel = null
    batchActiveCdpPort = opts.cdpPort ?? 9222
    lastCdpPortForKill = batchActiveCdpPort
    lastAutomationBatchProgress = { phase: 'init', runIndex: 0, totalRuns: 0, message: '准备中…' }
    broadcastAutomationStatus()
    try {
      const result = await runAutomationBatch(opts, {
        launchApp: (appPath, args, sessionLabel, onLaunchStatus) =>
          launchTargetApp(appPath, args, sessionLabel, onLaunchStatus),
        endSession: () => endSession(),
        killTarget: () => killMonitoredTargetApp(),
        resetRuntime: () => {
          forceResetCollectChain()
          resetMonitorRuntimeState()
        },
        isSessionRunning: () => currentSession?.status === 'running',
        ensureMonitorActive: (cdpPort, sessionLabel) => ensureBatchMonitorActive(cdpPort, sessionLabel),
        onProgress: (p) => {
          lastAutomationBatchProgress = p
          console.log(`[Batch][${p.phase}] ${p.message}`)
          broadcastToRenderer('automation:progress', p)
          broadcastAutomationStatus()
        },
      })
      return { ok: true, ...result }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      automationBatchRunning = false
      lastAutomationBatchProgress = null
      batchActiveSessionLabel = null
      batchActiveCdpPort = null
      stopCollecting()
      resetMonitorRuntimeState()
      clearExternalMonitorState()
      targetAppProcess = null
      broadcastAutomationStatus()
    }
  })

  ipcMain.handle('automation:convert-playwright', async (_e, payload: { source: string; stepDelayMs?: number }) => {
    const source = payload?.source?.trim()
    if (!source) return { ok: false, error: 'source 为空' }
    try {
      const { pathToFileURL } = await import('url')
      const modPath = path.join(__dirname_electron, '../scripts/playwright-to-scenario.mjs')
      const mod = await import(pathToFileURL(modPath).href)
      const stepDelay = payload.stepDelayMs ?? 5000
      const scenario = mod.convertPlaywrightSource(source, 'converted', stepDelay)
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').slice(0, 15)
      const rel = `scripts/scenarios/converted-${stamp}.scenario.json`
      const abs = resolveScenarioPath(rel)
      const content = JSON.stringify(scenario, null, 2)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, content, 'utf-8')
      return { ok: true, scenarioPath: rel, stepCount: scenario.steps?.length ?? 0, content }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('automation:read-scenario', async (_e, scenarioPath: string) => {
    const rel = String(scenarioPath ?? '').trim()
    if (!rel) return { ok: false, error: '场景路径为空' }
    try {
      const abs = resolveScenarioPath(rel)
      if (!fs.existsSync(abs)) return { ok: false, error: `场景不存在: ${rel}` }
      const content = await fs.promises.readFile(abs, 'utf-8')
      JSON.parse(content)
      return { ok: true, scenarioPath: toScenarioDisplayPath(abs), content }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('automation:write-scenario', async (_e, payload: { scenarioPath: string; content: string }) => {
    const rel = String(payload?.scenarioPath ?? '').trim()
    const content = payload?.content ?? ''
    if (!rel) return { ok: false, error: '场景路径为空' }
    if (!content.trim()) return { ok: false, error: '内容为空' }
    try {
      JSON.parse(content)
      const abs = resolveScenarioPath(rel)
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, content, 'utf-8')
      return { ok: true, scenarioPath: toScenarioDisplayPath(abs) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('dialog:pick-scenario', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win) return { canceled: true as const }
    const scenariosDir = path.join(getMonitorAppRoot(), 'scripts', 'scenarios')
    const r = await dialog.showOpenDialog(win, {
      title: '选择场景 JSON',
      defaultPath: fs.existsSync(scenariosDir) ? scenariosDir : getMonitorAppRoot(),
      filters: [
        { name: '场景 JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (r.canceled || !r.filePaths[0]) return { canceled: true as const }
    const displayPath = toScenarioDisplayPath(r.filePaths[0])
    return { canceled: false as const, path: displayPath }
  })

  ipcMain.handle('dialog:save-scenario', async (_e, suggestedName?: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!win) return { canceled: true as const }
    const scenariosDir = path.join(getMonitorAppRoot(), 'scripts', 'scenarios')
    const r = await dialog.showSaveDialog(win, {
      title: '另存场景 JSON',
      defaultPath: path.join(
        scenariosDir,
        suggestedName?.trim() || 'my.scenario.json',
      ),
      filters: [{ name: '场景 JSON', extensions: ['json'] }],
    })
    if (r.canceled || !r.filePath) return { canceled: true as const }
    const displayPath = toScenarioDisplayPath(r.filePath)
    return { canceled: false as const, path: displayPath }
  })

  // ---- 外部应用启动 / 附加到进程 ----
  ipcMain.handle('app:launch', async (_e, appPath: string, args: string[]) => {
    return launchTargetApp(appPath, args)
  })

  /** 枚举系统中全部进程（C++ Toolhelp32），用于「附加到已有进程」列表 */
  ipcMain.handle('process:list-all', (): SystemProcessListItem[] => {
    if (!isNativeMemoryLoaded()) {
      console.warn('[MonitorTool] process:list-all: native module not loaded')
      return []
    }
    return enumerateAllProcessesSync()
  })

  /**
   * 附加到已运行的进程进行监控（替代 launchTargetApp 的 execFile 方式）。
   * 前端先调 process:list-all 获取列表，用户选择后传入 pid。
   */
  ipcMain.handle('process:attach', async (_e, pid: number, label?: string) => {
    if (!Number.isFinite(pid) || pid <= 0) {
      return { success: false, error: '无效的 PID' }
    }
    const allProcesses = enumerateAllProcessesSync()
    const proc = allProcesses.find((p) => p.pid === pid)
    if (!proc) {
      return { success: false, error: `PID ${pid} 未在当前进程列表中找到，可能已退出` }
    }
    // 将自定义 label 注入 processInfo，供 attachToProcess 使用
    return attachToProcess(pid, proc, label)
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

      // 导出数据 = 报告页读到的原始文件，一字不差
      const reportFile = path.join(storageDir, `${sessionId}.report.json`)
      const snapFile = path.join(storageDir, `${sessionId}.snapshots`)

      // 原样读取 report.json（报告页 session:get-report 读的就是它）
      let reportData: Record<string, unknown> | null = null
      if (fs.existsSync(reportFile)) {
        try {
          reportData = JSON.parse(fs.readFileSync(reportFile, 'utf-8'))
        } catch { /* ignore */ }
      }

      // 原样读取 snapshots 文件（报告页 getSessionSnapshots 读的就是它）
      let snapshotsRaw: string[] = []
      if (fs.existsSync(snapFile)) {
        const content = fs.readFileSync(snapFile, 'utf-8')
        snapshotsRaw = content.trim().split('\n').filter(Boolean)
      }
      const snapshots = snapshotsRaw.map((line) => {
        try { return JSON.parse(line) } catch { return null }
      }).filter((x): x is NonNullable<typeof x> => x != null)

      const exportData: Record<string, unknown> = {
        version: 2,
        tool: 'Electron Memory Monitor Tool',
        exportTime: new Date().toISOString(),
        session,
        /** 与报告页 session:get-report 返回完全一致 */
        report: reportData,
        snapshotsCount: snapshots.length,
        /** 与报告页 getSessionSnapshots 返回完全一致（每个元素是一个快照对象） */
        snapshots,
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

  void startAutomationServer({
    queueMark: queueEventMark,
    getStatus: () => getAutomationStatusSnapshot(),
    endSession: () => endSession(),
    launchMonitor: async (body: LaunchMonitorBody) => {
      const port = body.cdpPort ?? 9222
      const extra = Array.isArray(body.args) ? body.args : []
      const args = [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        ...extra.filter((a) => !String(a).startsWith('--remote-debugging-port=')),
      ]
      const r = await launchTargetApp(body.appPath, args)
      if (!r.success) return { ok: false, error: r.error ?? 'launch failed' }
      return { ok: true, sessionId: r.session?.id }
    },
    killTarget: () => killMonitoredTargetApp(),
  }).catch((e) => {
    console.warn('[MonitorTool] 自动化 API 启动失败:', e)
  })

  const wsStatus = getNativeModuleStatus()
  console.log(
    `[MonitorTool] 专用工作集采集后端: ${wsStatus.backend}${wsStatus.error ? ` (${wsStatus.error})` : ''}`,
  )

  // 空闲态不采集；由「开始记录」「附加并监控」「启动并监控」触发 startCollecting

  app.on('activate', () => {
    if (!mainWindow) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  stopCollecting()
  if (process.platform === 'darwin') {
    if (currentSession?.status === 'running') void endSession()
    return
  }
  // Windows/Linux：须等会话落盘后再 quit，否则与原先 fire-and-forget 一样可能丢数据
  if (currentSession?.status === 'running') {
    void endSession().finally(() => app.quit())
  } else {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopAutomationServer()
  stopCollecting()
  if (currentSession?.status === 'running') {
    void endSession()
  }
})
