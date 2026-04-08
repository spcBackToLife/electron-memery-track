/**
 * 内存快照数据结构
 * 每次采集产出一个 MemorySnapshot，包含所有进程的内存信息
 */

/** 单个进程的内存信息 */
export interface ProcessMemoryInfo {
  /** 进程 PID */
  pid: number
  /** 进程类型：Browser(主进程) / Tab(渲染进程) / GPU / Utility */
  type: 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Zygote' | string
  /** 用户可读的进程名称（如窗口标题） */
  name?: string
  /** 是否是监控面板自身的进程 */
  isMonitorProcess?: boolean

  /** 来自 app.getAppMetrics() */
  cpu: {
    percentCPUUsage: number
    idleWakeupsPerSecond: number
  }
  memory: {
    /** 工作集大小 (KB) - 进程实际使用的物理内存 */
    workingSetSize: number
    /** 峰值工作集 (KB) */
    peakWorkingSetSize: number
    /** 私有字节 (KB) - 不与其他进程共享的内存 */
    privateBytes?: number
  }

  /** 仅渲染进程：关联的 webContents ID */
  webContentsId?: number
  /** 仅渲染进程：窗口标题 */
  windowTitle?: string
}

/** 主进程 V8 堆统计 */
export interface V8HeapStats {
  /** 已使用堆大小 (bytes) */
  heapUsed: number
  /** 堆总大小 (bytes) */
  heapTotal: number
  /** V8 外部内存 (bytes) */
  external: number
  /** ArrayBuffers 占用 (bytes) */
  arrayBuffers: number
  /** RSS (bytes) */
  rss: number
}

/** V8 堆详细统计 */
export interface V8HeapDetailStats extends V8HeapStats {
  /** V8 总堆大小 */
  totalHeapSize: number
  /** V8 已使用堆大小 */
  usedHeapSize: number
  /** V8 堆大小限制 */
  heapSizeLimit: number
  /** V8 malloc 已分配内存 */
  mallocedMemory: number
  /** V8 malloc 峰值 */
  peakMallocedMemory: number
  /** 分离的上下文数 - 泄漏关键信号 */
  numberOfDetachedContexts: number
  /** 原生上下文数 */
  numberOfNativeContexts: number
  /** 堆空间详情 */
  heapSpaces?: V8HeapSpaceInfo[]
}

/** V8 堆空间信息 */
export interface V8HeapSpaceInfo {
  name: string
  size: number
  usedSize: number
  availableSize: number
  physicalSize: number
}

/** 系统内存信息 */
export interface SystemMemoryInfo {
  /** 总物理内存 (bytes) */
  total: number
  /** 可用物理内存 (bytes) */
  free: number
  /** 已使用物理内存 (bytes) */
  used: number
  /** 使用率 (0-100) */
  usagePercent: number
}

/** 渲染进程 V8 详情（需要 preload 注入） */
export interface RendererV8Detail {
  webContentsId: number
  pid: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}

/** 事件标记 */
export interface EventMark {
  timestamp: number
  label: string
  metadata?: Record<string, unknown>
}

/** 完整的内存快照 */
export interface MemorySnapshot {
  /** 快照时间戳 (ms) */
  timestamp: number
  /** 所属会话 ID */
  sessionId?: string
  /** 快照序号 */
  seq: number

  /** 所有进程的内存信息 */
  processes: ProcessMemoryInfo[]
  /** 所有进程的总工作集大小 (KB) */
  totalWorkingSetSize: number

  /** 主进程 V8 堆统计 */
  mainProcessMemory: V8HeapStats
  /** 主进程 V8 详细统计 */
  mainProcessV8Detail: V8HeapDetailStats

  /** 系统内存信息 */
  system: SystemMemoryInfo

  /** 渲染进程 V8 详情（可选，需要 preload 注入） */
  rendererDetails?: RendererV8Detail[]

  /** 事件标记 */
  marks?: EventMark[]
}
