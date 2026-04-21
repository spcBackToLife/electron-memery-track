/**
 * Preload 脚本 - 暴露安全的 IPC API 到渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // ---- 采集控制 ----
  startCollect: () => ipcRenderer.invoke('collect:start'),
  stopCollect: () => ipcRenderer.invoke('collect:stop'),

  // ---- 会话管理 ----
  startSession: (label: string, description?: string) =>
    ipcRenderer.invoke('session:start', label, description),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSessionReport: (sessionId: string) =>
    ipcRenderer.invoke('session:get-report', sessionId),
  getSessionSnapshots: (sessionId: string, maxPoints?: number) =>
    ipcRenderer.invoke('session:get-snapshots', sessionId, maxPoints),
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke('session:delete', sessionId),

  // ---- 对比 ----
  compareSessions: (baseId: string, targetId: string) =>
    ipcRenderer.invoke('session:compare', baseId, targetId),

  // ---- 标记 ----
  addMark: (label: string, metadata?: Record<string, unknown>) =>
    ipcRenderer.invoke('mark:add', label, metadata),

  // ---- 外部应用 ----
  launchApp: (appPath: string, args?: string[]) =>
    ipcRenderer.invoke('app:launch', appPath, args || []),
  getTargetApp: () => ipcRenderer.invoke('app:get-target'),
  getExternalExcludedPids: () => ipcRenderer.invoke('external:get-excluded-pids') as Promise<number[]>,
  setPidExcludedFromTotal: (pid: number, excluded: boolean) =>
    ipcRenderer.invoke('external:set-pid-excluded', pid, excluded) as Promise<boolean>,
  resetTotalExclusion: () => ipcRenderer.invoke('external:reset-total-exclusion') as Promise<boolean>,
  pickExecutable: () => ipcRenderer.invoke('dialog:pick-exe'),

  // ---- 导出 ----
  exportSession: (sessionId: string) =>
    ipcRenderer.invoke('export:session', sessionId),

  /** 追加一行 NDJSON 到 userData/mmt-diag.log（与主进程 [MMT:diag] 同文件） */
  diagAppend: (row: Record<string, unknown>) => ipcRenderer.send('diag:append', row),
  getDiagLogPath: () => ipcRenderer.invoke('diag:get-log-path') as Promise<string | null>,

  // ---- 事件监听（主进程 -> 渲染进程） ----
  onSnapshotUpdate: (callback: (snapshot: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('snapshot:update', handler)
    return () => ipcRenderer.removeListener('snapshot:update', handler)
  },
  onSessionStarted: (callback: (session: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('session:started', handler)
    return () => ipcRenderer.removeListener('session:started', handler)
  },
  onSessionEnded: (callback: (data: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data)
    ipcRenderer.on('session:ended', handler)
    return () => ipcRenderer.removeListener('session:ended', handler)
  },
}

contextBridge.exposeInMainWorld('monitorAPI', api)
