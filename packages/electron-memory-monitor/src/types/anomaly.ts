/**
 * 异常检测相关类型
 */

/** 异常严重级别 */
export type AnomalySeverity = 'info' | 'warning' | 'critical'

/** 异常类别 */
export type AnomalyCategory = 'memory-leak' | 'spike' | 'threshold' | 'detached-context' | 'trend'

/** 异常事件 */
export interface AnomalyEvent {
  /** 事件 ID */
  id: string
  /** 发现时间 */
  timestamp: number
  /** 严重级别 */
  severity: AnomalySeverity
  /** 类别 */
  category: AnomalyCategory
  /** 涉及的进程类型 */
  processType?: string
  /** 涉及的进程 PID */
  pid?: number
  /** 标题 */
  title: string
  /** 详细描述 */
  description: string
  /** 触发值 */
  value?: number
  /** 阈值 */
  threshold?: number
}

/** 异常检测规则 */
export interface AnomalyRule {
  /** 规则 ID */
  id: string
  /** 规则名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /** 检测函数 */
  detect: (snapshots: import('./snapshot').MemorySnapshot[], latestSnapshot: import('./snapshot').MemorySnapshot) => AnomalyEvent | null
}
