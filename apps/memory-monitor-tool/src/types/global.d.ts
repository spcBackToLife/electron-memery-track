// 页面类型
export type PageType = 'dashboard' | 'report' | 'compare'

// Monitor API（由 preload 注入）
export interface MonitorAPI {
  // 采集
  startCollect: () => Promise<boolean>
  stopCollect: () => Promise<boolean>

  // 会话
  startSession: (label: string, description?: string) => Promise<unknown>
  stopSession: () => Promise<unknown>
  listSessions: () => Promise<unknown[]>
  getSessionReport: (sessionId: string) => Promise<unknown | null>
  getSessionSnapshots: (sessionId: string, maxPoints?: number) => Promise<unknown[]>
  deleteSession: (sessionId: string) => Promise<boolean>

  // 对比
  compareSessions: (baseId: string, targetId: string) => Promise<unknown | null>

  // 标记
  addMark: (label: string, metadata?: Record<string, unknown>) => Promise<boolean>

  // 外部应用
  launchApp: (
    appPath: string,
    args?: string[],
  ) => Promise<{
    success: boolean
    error?: string
    info?: { appPath: string; appName: string }
    session?: { id: string; label: string; status: string }
  }>
  getTargetApp: () => Promise<{
    appName: string
    appPath: string
    startTime: string
  } | null>
  getExternalExcludedPids: () => Promise<number[]>
  setPidExcludedFromTotal: (pid: number, excluded: boolean) => Promise<boolean>
  resetTotalExclusion: () => Promise<boolean>
  pickExecutable: () => Promise<{ canceled: true } | { canceled: false; path: string }>

  // 导出
  exportSession: (sessionId: string) => Promise<{ success: boolean; filePath?: string; error?: string }>

  /** 诊断 NDJSON 写入 userData/mmt-diag.log */
  diagAppend: (row: Record<string, unknown>) => void
  getDiagLogPath: () => Promise<string | null>

  // 事件监听
  onSnapshotUpdate: (callback: (data: unknown) => void) => () => void
  onSessionStarted: (callback: (data: unknown) => void) => () => void
  onSessionEnded: (callback: (data: unknown) => void) => () => void
}

declare global {
  interface Window {
    monitorAPI: MonitorAPI
  }
}
