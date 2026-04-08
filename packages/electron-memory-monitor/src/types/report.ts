/**
 * 报告与对比相关类型
 */

import type { AnomalyEvent } from './anomaly'

/** 指标统计摘要 */
export interface MetricSummary {
  /** 首次采样值 */
  initial: number
  /** 最后采样值 */
  final: number
  min: number
  max: number
  avg: number
  /** 中位数 */
  p50: number
  p95: number
  p99: number
  /** 变化量 final - initial */
  delta: number
  /** 变化百分比 */
  deltaPercent: number
}

/** 趋势信息 */
export interface TrendInfo {
  /** 线性回归斜率 (bytes/s) */
  slope: number
  /** 拟合优度 (0~1) */
  r2: number
  /** 趋势方向 */
  direction: 'stable' | 'growing' | 'shrinking'
  /** 置信度 */
  confidence: 'high' | 'medium' | 'low'
}

/** 改进建议 */
export interface Suggestion {
  /** 建议 ID */
  id: string
  /** 严重级别 */
  severity: 'info' | 'warning' | 'critical'
  /** 类别 */
  category: 'memory-leak' | 'optimization' | 'architecture'
  /** 标题 */
  title: string
  /** 描述 */
  description: string
  /** 具体建议步骤 */
  suggestions: string[]
  /** 相关代码示例 */
  relatedCode?: string[]
}

/** 会话报告 */
export interface SessionReport {
  // ===== 元信息 =====
  sessionId: string
  label: string
  description?: string
  startTime: number
  endTime: number
  duration: number

  environment: {
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
    platform: string
    arch: string
    totalSystemMemory: number
    cpuModel: string
    cpuCores: number
  }

  // ===== 统计汇总 =====
  summary: {
    totalProcesses: { min: number; max: number; avg: number }
    totalMemory: MetricSummary
    byProcessType: {
      browser: MetricSummary
      renderer: MetricSummary[]
      gpu: MetricSummary | null
      utility: MetricSummary | null
    }
    mainV8Heap: {
      heapUsed: MetricSummary
      heapTotal: MetricSummary
      external: MetricSummary
      arrayBuffers: MetricSummary
    }
    trends: {
      totalMemory: TrendInfo
      browserMemory: TrendInfo
      rendererMemory: TrendInfo
    }
  }

  // ===== 异常事件 =====
  anomalies: AnomalyEvent[]

  // ===== 改进建议 =====
  suggestions: Suggestion[]

  // ===== 数据文件 =====
  dataFile: string
}

/** 指标差异 */
export interface MetricDiff {
  base: number
  target: number
  delta: number
  deltaPercent: number
  status: 'improved' | 'degraded' | 'unchanged'
  severity?: 'minor' | 'major' | 'critical'
}

/** 劣化项 */
export interface Regression {
  metric: string
  description: string
  baseValue: number
  targetValue: number
  deltaPercent: number
  severity: 'minor' | 'major' | 'critical'
  suggestion: string
}

/** 改进项 */
export interface Improvement {
  metric: string
  description: string
  baseValue: number
  targetValue: number
  deltaPercent: number
}

/** 对比报告 */
export interface CompareReport {
  base: { sessionId: string; label: string }
  target: { sessionId: string; label: string }

  overall: {
    totalMemory: MetricDiff
    browserMemory: MetricDiff
    rendererMemory: MetricDiff
    gpuMemory: MetricDiff | null
  }

  v8Heap: {
    heapUsed: MetricDiff
    heapTotal: MetricDiff
    external: MetricDiff
  }

  trendChanges: {
    metric: string
    baseSlope: number
    targetSlope: number
    change: 'improved' | 'degraded' | 'unchanged'
  }[]

  regressions: Regression[]
  improvements: Improvement[]

  verdict: 'pass' | 'warn' | 'fail'
  verdictReason: string
}

/** GC 结果 */
export interface GCResult {
  beforeHeapUsed: number
  afterHeapUsed: number
  freed: number
  freedPercent: number
  timestamp: number
}
