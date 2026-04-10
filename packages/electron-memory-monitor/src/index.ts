/**
 * @electron-memory/monitor
 * 
 * Electron 内存监控 SDK
 * 零代码入侵 - 一行代码接入任何 Electron 项目
 */

export { ElectronMemoryMonitor } from './core/monitor'
/** 若延迟到 app.ready 之后才 new ElectronMemoryMonitor，请在本文件最顶部先调用此函数 */
export { registerDashboardSchemePrivileged } from './core/dashboard-protocol'

// 类型导出
export type { MonitorConfig } from './types/config'
export type {
  MemorySnapshot,
  ProcessMemoryInfo,
  V8HeapStats,
  V8HeapDetailStats,
  V8HeapSpaceInfo,
  SystemMemoryInfo,
  RendererV8Detail,
  EventMark,
} from './types/snapshot'
export type { TestSession, SessionIndex, SessionsListPayload } from './types/session'
export type { AnomalyEvent, AnomalySeverity, AnomalyCategory, AnomalyRule } from './types/anomaly'
export type {
  SessionReport,
  SessionEventMark,
  CompareReport,
  MetricSummary,
  TrendInfo,
  Suggestion,
  MetricDiff,
  Regression,
  Improvement,
  GCResult,
} from './types/report'
export { IPC_CHANNELS } from './ipc/channels'
