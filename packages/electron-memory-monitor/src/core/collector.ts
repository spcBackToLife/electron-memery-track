/**
 * MemoryCollector - 内存数据采集器
 * 
 * 核心职责：定时从各种数据源采集内存信息，组装成 MemorySnapshot
 * 运行在主进程中，不需要渲染进程配合即可获取所有进程的内存概览
 */

import { app, BrowserWindow, webContents } from 'electron'
import * as v8 from 'v8'
import * as os from 'os'
import { EventEmitter } from 'events'
import type {
  MemorySnapshot,
  ProcessMemoryInfo,
  V8HeapStats,
  V8HeapDetailStats,
  V8HeapSpaceInfo,
  SystemMemoryInfo,
  EventMark,
  RendererV8Detail,
} from '../types/snapshot'
import type { MonitorConfig } from '../types/config'
import { createPrivateWsProvider, getNativeModuleStatus, type PrivateWorkingSetProvider } from './native-memory'

export class MemoryCollector extends EventEmitter {
  private config: MonitorConfig
  private timer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private currentSessionId: string | null = null
  private pendingMarks: EventMark[] = []
  private rendererDetails: Map<number, RendererV8Detail> = new Map()
  private monitorWindowId: number | null = null
  /**
   * 专用工作集查询 Provider（自动选择 Native C++ 或 PowerShell fallback）
   */
  private privateWsProvider: PrivateWorkingSetProvider
  /**
   * 最近一次通过系统 API 查询到的各 PID 专用工作集缓存 (PID → KB)。
   * 由于系统查询有一定延迟，采用异步刷新 + 缓存策略，不阻塞主采集循环。
   */
  private privateWsCache: Map<number, number> = new Map()
  /** 上次刷新 privateWsCache 的时间戳 */
  private privateWsLastRefresh = 0
  /** privateWsCache 刷新间隔 (ms)，与采集间隔对齐但不能太频繁 */
  private privateWsRefreshInterval = 2000

  constructor(config: MonitorConfig) {
    super()
    this.config = config
    this.privateWsProvider = createPrivateWsProvider()

    const status = getNativeModuleStatus()
    console.log(`[MemoryCollector] Private WS backend: ${status.backend}${status.error ? ` (${status.error})` : ''}`)
  }

  /** 设置监控面板的 webContents ID，用于标记 */
  setMonitorWindowId(id: number | null): void {
    this.monitorWindowId = id
  }

  /** 设置当前会话 ID */
  setSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId
  }

  /** 添加事件标记 */
  addMark(label: string, metadata?: Record<string, unknown>): void {
    this.pendingMarks.push({
      timestamp: Date.now(),
      label,
      metadata,
    })
  }

  /** 更新渲染进程 V8 详情 */
  updateRendererDetail(detail: RendererV8Detail): void {
    this.rendererDetails.set(detail.webContentsId, detail)
  }

  /** 开始采集 */
  start(): void {
    if (this.timer) return

    // privateWs 的刷新间隔：Native 模块速度快可以频繁刷新，PowerShell fallback 不能太频繁
    this.privateWsRefreshInterval = this.privateWsProvider.backend === 'native'
      ? Math.max(500, this.config.collectInterval)
      : Math.max(2000, this.config.collectInterval * 2)

    // 立即采集一次
    this.collect()

    this.timer = setInterval(() => {
      this.collect()
    }, this.config.collectInterval)
  }

  /** 停止采集 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 执行一次采集 */
  private collect(): void {
    try {
      const snapshot = this.buildSnapshot()
      this.emit('snapshot', snapshot)
    } catch (err) {
      this.emit('error', err)
    }
  }

  /** 构建完整的内存快照 */
  private buildSnapshot(): MemorySnapshot {
    const timestamp = Date.now()
    const processes = this.collectProcesses()
    const mainProcessMemory = this.collectMainProcessMemory()
    const mainProcessV8Detail = this.collectMainProcessV8Detail()
    const system = this.collectSystemMemory()

    // 计算总工作集大小（排除监控面板自身进程）
    const totalWorkingSetSize = processes.reduce(
      (sum, p) => p.isMonitorProcess ? sum : sum + p.memory.workingSetSize,
      0
    )

    // 收集待处理的事件标记
    const marks = this.pendingMarks.length > 0 ? [...this.pendingMarks] : undefined
    this.pendingMarks = []

    // 收集渲染进程 V8 详情
    const rendererDetails = this.rendererDetails.size > 0
      ? Array.from(this.rendererDetails.values())
      : undefined

    const snapshot: MemorySnapshot = {
      timestamp,
      sessionId: this.currentSessionId ?? undefined,
      seq: this.seq++,
      processes,
      totalWorkingSetSize,
      mainProcessMemory,
      mainProcessV8Detail,
      system,
      rendererDetails,
      marks,
    }

    return snapshot
  }

  /** 采集所有进程信息 */
  private collectProcesses(): ProcessMemoryInfo[] {
    const metrics = app.getAppMetrics()
    const wcList = webContents.getAllWebContents()

    // 构建 PID → webContents 映射
    const pidToWc = new Map<number, Electron.WebContents>()
    for (const wc of wcList) {
      try {
        const pid = wc.getOSProcessId()
        pidToWc.set(pid, wc)
      } catch {
        // webContents 可能已销毁
      }
    }

    // 构建 webContentsId → BrowserWindow 标题映射
    const wcIdToTitle = new Map<number, string>()
    const allWindows = BrowserWindow.getAllWindows()
    for (const win of allWindows) {
      try {
        wcIdToTitle.set(win.webContents.id, win.getTitle())
      } catch {
        // 窗口可能已销毁
      }
    }

    const allPids = metrics.map((m) => m.pid)

    const result = metrics.map((metric) => {
      const wc = pidToWc.get(metric.pid)
      let windowTitle: string | undefined
      let webContentsId: number | undefined
      let isMonitorProcess = false

      if (wc) {
        webContentsId = wc.id
        windowTitle = wcIdToTitle.get(wc.id)

        // 检查是否是监控面板自身的进程
        if (this.monitorWindowId !== null && wc.id === this.monitorWindowId) {
          isMonitorProcess = true
          windowTitle = '[Memory Monitor]'
        }
      }

      // 应用用户自定义标签
      let name = windowTitle
      if (windowTitle && this.config.processLabels[windowTitle]) {
        name = this.config.processLabels[windowTitle]
      }

      const info: ProcessMemoryInfo = {
        pid: metric.pid,
        type: metric.type,
        name,
        isMonitorProcess,
        cpu: {
          percentCPUUsage: metric.cpu.percentCPUUsage,
          idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
        },
        memory: {
          workingSetSize: metric.memory.workingSetSize,
          peakWorkingSetSize: metric.memory.peakWorkingSetSize,
          privateBytes: (metric.memory as unknown as Record<string, number>).privateBytes,
          privateWorkingSet: this.privateWsCache.get(metric.pid),
        },
        webContentsId,
        windowTitle,
      }

      return info
    })

    // 触发异步刷新专用工作集缓存（不阻塞当前采集）
    this.maybeRefreshPrivateWs(allPids)

    return result
  }

  /**
   * 异步刷新专用工作集缓存。
   * 按 privateWsRefreshInterval 节流，刷新完成后下一次 collect 自动使用新数据。
   * 底层自动选择 Native C++ 或 PowerShell fallback。
   */
  private maybeRefreshPrivateWs(pids: number[]): void {
    const now = Date.now()
    if (!this.privateWsProvider.available || now - this.privateWsLastRefresh < this.privateWsRefreshInterval) return
    this.privateWsLastRefresh = now

    this.privateWsProvider.queryPrivateWorkingSet(pids).then((map) => {
      if (map.size > 0) {
        this.privateWsCache = map
      }
    }).catch(() => {
      // 忽略查询失败
    })
  }

  /** 采集主进程 Node.js 内存 */
  private collectMainProcessMemory(): V8HeapStats {
    const mem = process.memoryUsage()
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss,
    }
  }

  /** 采集主进程 V8 详细统计 */
  private collectMainProcessV8Detail(): V8HeapDetailStats {
    const mem = process.memoryUsage()
    // 注意：v8.getHeapStatistics() 返回 snake_case 字段名
    const heapStats = v8.getHeapStatistics() as Record<string, number>

    let heapSpaces: V8HeapSpaceInfo[] | undefined
    if (this.config.enableV8HeapSpaces) {
      // 注意：v8.getHeapSpaceStatistics() 返回 snake_case 字段名
      heapSpaces = v8.getHeapSpaceStatistics().map((space: Record<string, unknown>) => ({
        name: (space.space_name ?? space.spaceName) as string,
        size: (space.space_size ?? space.spaceSize) as number,
        usedSize: (space.space_used_size ?? space.spaceUsedSize) as number,
        availableSize: (space.space_available_size ?? space.spaceAvailableSize) as number,
        physicalSize: (space.physical_space_size ?? space.physicalSpaceSize) as number,
      }))
    }

    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss,
      totalHeapSize: (heapStats.total_heap_size ?? heapStats.totalHeapSize) as number,
      usedHeapSize: (heapStats.used_heap_size ?? heapStats.usedHeapSize) as number,
      heapSizeLimit: (heapStats.heap_size_limit ?? heapStats.heapSizeLimit) as number,
      mallocedMemory: (heapStats.malloced_memory ?? heapStats.mallocedMemory) as number,
      peakMallocedMemory: (heapStats.peak_malloced_memory ?? heapStats.peakMallocedMemory) as number,
      numberOfDetachedContexts: (heapStats.number_of_detached_contexts ?? heapStats.numberOfDetachedContexts) as number,
      numberOfNativeContexts: (heapStats.number_of_native_contexts ?? heapStats.numberOfNativeContexts) as number,
      heapSpaces,
    }
  }

  /** 采集系统内存 */
  private collectSystemMemory(): SystemMemoryInfo {
    const total = os.totalmem()
    const free = os.freemem()
    const used = total - free
    return {
      total,
      free,
      used,
      usagePercent: Math.round((used / total) * 10000) / 100,
    }
  }
}
