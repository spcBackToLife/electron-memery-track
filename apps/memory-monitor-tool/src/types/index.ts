/**
 * Electron Memory Monitor Tool — 类型定义
 * 面向测试场景，关注进程级内存，去掉 V8 等技术细节
 */

// ============ 进程与快照（简化版） ============

export interface ProcessMemoryInfo {
  pid: number
  type: 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Zygote' | string
  name?: string
  /** 外部监控：镜像路径（Win32_Process.ExecutablePath） */
  executablePath?: string
  /** 外部监控：启动命令行（Win32_Process.CommandLine） */
  commandLine?: string
  /**
   * 外部监控：从命令行解析的 Chromium/CEF 角色（如 gpu-process、renderer），IPC 瘦身时仍保留；无则缺省。
   */
  chromiumType?: string
  cpu: {
    percentCPUUsage: number
    idleWakeupsPerSecond: number
  }
  /** 外部监控：相对上一拍的磁盘速率（KB/s） */
  diskReadKBps?: number
  diskWriteKBps?: number
  memory: {
    workingSetSize: number       // 工作集 (KB)，作回退参考
    peakWorkingSetSize: number   // 峰值工作集 (KB)
    /** 专用工作集 (KB)，主进程写入；统计口径见 getEffectiveMemoryKB */
    privateWorkingSet?: number
  }
}

export interface MemorySnapshot {
  timestamp: number
  sessionId?: string
  seq: number
  processes: ProcessMemoryInfo[]
  /** 各进程有效内存之和 (KB)，有效值 = 专用工作集（若已采集）否则工作集 */
  totalWorkingSetSize: number
  system: {
    total: number                 // 系统总物理内存 (bytes)
    free: number                  // 可用 (bytes)
    used: number                  // 已用 (bytes)
    usagePercent: number          // 使用率 (%)
  }
  marks?: EventMark[]
  monitorMode?: 'self' | 'external'
  externalTargetPath?: string
  externalRootPid?: number
  /** 外部模式：参与 totalWorkingSetSize 汇总的 PID */
  externalTotalIncludedPids?: number[]
  /** 外部模式：CPU/磁盘为子树全部 PID 速率之和；GPU/显存为按子树 PID 过滤的 PDH 采样（首拍磁盘为 0） */
  externalMetrics?: {
    aggregateCpuPercent: number
    diskReadKBps: number
    diskWriteKBps: number
    gpuEnginePercent: number | null
    gpuDedicatedMB: number | null
  }
}

export interface EventMark {
  timestamp: number
  label: string
  metadata?: Record<string, unknown>
}

// ============ 会话 ============

export interface TestSession {
  id: string
  label: string
  description?: string
  startTime: number
  endTime?: number
  snapshotCount: number
  status: 'running' | 'completed'
  dataFile: string
}

export interface SessionsListPayload {
  sessions: TestSession[]
  activeSessionId: string | null
}

import type { ResourceSummaryPayload } from '../utils/reportResourceSummary'

// ============ 报告（面向测试的解读型报告） ============

/** 阶段标记 + 该拍快照时的分类内存（KB），与 SDK SessionEventMark 对齐便于对照 */
export interface ReportEventMark {
  timestamp: number
  label: string
  metadata?: Record<string, unknown>
  totalWorkingSetKB: number
  browserKB: number
  rendererKB: number
  gpuKB: number
}

export interface ReportSummary {
  sessionId: string
  label: string
  description?: string
  startTime: number
  endTime: number
  durationMs: number
  snapshotCount: number

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

  trendAnalysis: {
    hasGrowthTrend: boolean
    growthRatePerMin: number
    growthAmountMB: number
    conclusion: 'PASS' | 'WARN' | 'FAIL'
    reason: string
  }

  dataPoints: Array<{
    timestamp: number
    totalMB: number
    browserMB: number
    rendererMB: number
    gpuMB: number
    processCount: number
    extCpuPercent?: number
    extDiskReadKBps?: number
    extDiskWriteKBps?: number
    extGpuEnginePercent?: number | null
    extGpuDedicatedMB?: number | null
  }>

  /** 外部监控：进程树合计所依据的 PID（报告生成时取自最后一次采样） */
  externalTotalMemoryBasis?: {
    includedPids: number[]
    labels: Record<string, string>
    note: string
  }

  /** 阶段标记汇总（写入 report.json；旧报告可能缺省，可由快照兜底推导） */
  eventMarks?: ReportEventMark[]

  /**
   * 外部监控会话：由 dataPoints 中带 ext* 的采样汇总（与实时监控 externalMetrics 同源）。
   * 旧版报告无此字段；仅有 dataPoints 时报告页可从 dataPoints 推导。
   */
  resourceSummary?: ResourceSummaryPayload
}

// ============ 对比结果 ============

export type PageType = 'dashboard' | 'report' | 'compare'

export interface CompareResult {
  baseSession: { id: string; label: string }
  targetSession: { id: string; label: string }
  comparison: {
    peakDiffMB: number
    peakChangePercent: number
    avgDiffMB: number
    avgChangePercent: number
    finalDiffMB: number
  }
  verdict: {
    status: 'IMPROVED' | 'REGRESSION' | 'STABLE' | 'INCONCLUSIVE'
    summary: string
    details: string[]
  }
}
