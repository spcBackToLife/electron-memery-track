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
  isNativeMemoryLoaded,
} from './native-memory'
import { fetchWindowsProcessTree } from './external-process-tree'

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
  cpu: { percentCPUUsage: number; idleWakeupsPerSecond: number }
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

// ============ 配置 ============

const CONFIG = {
  collectInterval: 2000,      // 采集间隔 (ms)
  maxSnapshotsPerSession: 5000,
  maxSessions: 100,
  maxSessionDuration: 24 * 60 * 60 * 1000, // 24h
  /**
   * 外部监控：WMI 父子链可能挂入无关进程（如 upgrade.exe）。
   * 为 true 时仅保留与「启动 exe」路径/命令行明显相关的 PID（根进程始终保留）。
   */
  externalSameAppTreeFilter: true,
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
 * 命令行来自 WMI（PowerShell 枚举），与 C++ 读取等价；若要在 native 里读可用 NtQueryInformationProcess(ProcessCommandLineInformation)，当前不必重复实现。
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

function buildSnapshotExternal(): MemorySnapshot {
  const timestamp = Date.now()
  const root = monitoredRootPid!
  maybeRefreshExternalTree()

  const displayPids = externalPidsCache.length > 0 ? externalPidsCache : [root]
  pruneExternalExcludedToTree(displayPids)

  const nativeMem = readExternalProcessMemoryNativeSync(displayPids)

  const processes: ProcessMemoryInfo[] = displayPids.map((pid) => {
    const row = nativeMem.get(pid)
    const privKb = row?.privateKb ?? 0
    const wsKb = row?.workingSetKb ?? 0
    const peakKb = row?.peakKb ?? wsKb
    const isRoot = pid === root
    const exe = externalExePathCache.get(pid)
    const cmd = externalCommandLineCache.get(pid)
    return {
      pid,
      type: (isRoot ? 'Browser' : 'Tab') as ProcessMemoryInfo['type'],
      name: externalNamesCache.get(pid),
      executablePath: exe,
      commandLine: cmd,
      cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
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
  }
}

function buildSnapshot(): MemorySnapshot {
  if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
    return buildSnapshotExternal()
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
  }>

  /** 外部监控：进程树合计所依据的 PID 及名称（取会话结束时最后一次采样） */
  externalTotalMemoryBasis?: {
    includedPids: number[]
    labels: Record<string, string>
    note: string
  }
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

    return {
      timestamp: s.timestamp,
      totalMB,
      browserMB,
      rendererMB,
      gpuMB,
      processCount: s.processes.length,
    }
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
    ...(externalTotalMemoryBasis ? { externalTotalMemoryBasis } : {}),
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

function startCollecting(): void {
  if (collectTimer) return

  initPrivateWsRefreshInterval()

  // 立即采集一次
  pushSnapshot(buildSnapshot())

  collectTimer = setInterval(() => {
    const snapshot = buildSnapshot()
    pushSnapshot(snapshot)
  }, CONFIG.collectInterval)

  console.log('[MonitorTool] Collection started, interval:', CONFIG.collectInterval, 'ms')
}

function stopCollecting(): void {
  if (collectTimer) {
    clearInterval(collectTimer)
    collectTimer = null
  }
  console.log('[MonitorTool] Collection stopped')
}

function pushSnapshot(snapshot: MemorySnapshot): void {
  // 缓存到缓冲区
  snapshotsBuffer.push(snapshot)

  // 如果有正在进行的会话，写入磁盘
  if (currentSession?.status === 'running') {
    const sessionDataFile = path.join(storageDir, currentSession.dataFile)
    try {
      fs.appendFileSync(sessionDataFile, JSON.stringify(snapshot) + '\n', 'utf-8')
      currentSession.snapshotCount++
    } catch (err) {
      console.error('[MonitorTool] Failed to write snapshot:', err)
    }
  }

  // 推送到 UI（限制推送频率避免卡顿）
  broadcastToRenderer('snapshot:update', snapshot)

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
      externalTotalExcludedPids = new Set()
      externalPidsCache = [childPid]
      externalNamesCache = new Map([[childPid, appName]])
      externalExePathCache = new Map([[childPid, appPath]])
      externalCommandLineCache = new Map()
      externalTreeLastRefresh = 0
      if (isNativeMemoryLoaded()) {
        monitoredRootPid = childPid
      } else {
        monitoredRootPid = null
        console.warn(
          '[MonitorTool] memory_native.node 未加载，无法按 C++ 路径采集外部进程树内存。请在本应用目录执行 pnpm run build:with-native 编译 native 后再试。',
        )
      }
      void fetchWindowsProcessTree(childPid).then((result) => {
        applyExternalTreeFetchResult(childPid, result.pids, result.names, result.exePath, result.commandLine)
      })

      // 为本次「启动并监控」自动新开测试会话（会结束当前运行中的会话）
      const session = startSession(`启动: ${appName}`, `可执行文件: ${appPath}`)

      // 给子进程一点时间完成窗口创建
      setTimeout(() => {
        resolve({ success: true, info: { appPath, appName }, session })
      }, 1500)
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
      try {
        pushSnapshot(buildSnapshot())
      } catch (err) {
        console.error('[MonitorTool] 排除设置后刷新快照失败:', err)
      }
    }
    return true
  })

  ipcMain.handle('external:reset-total-exclusion', (): boolean => {
    externalTotalExcludedPids.clear()
    if (process.platform === 'win32' && monitoredRootPid != null && isNativeMemoryLoaded()) {
      try {
        pushSnapshot(buildSnapshot())
      } catch (err) {
        console.error('[MonitorTool] 重置排除后刷新快照失败:', err)
      }
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
