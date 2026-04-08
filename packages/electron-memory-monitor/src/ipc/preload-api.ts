/**
 * Preload API 辅助
 * 
 * 定义暴露给监控面板渲染进程的 API
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from './channels'

/** 监控面板 preload 注入的 API 类型 */
export interface MonitorPanelAPI {
  // 会话控制
  startSession: (label: string, description?: string) => Promise<string>
  stopSession: () => Promise<unknown>
  getSessions: () => Promise<unknown[]>
  getSessionReport: (sessionId: string) => Promise<unknown>
  compareSessions: (baseId: string, targetId: string) => Promise<unknown>

  // 数据查询
  getSessionSnapshots: (sessionId: string, startTime?: number, endTime?: number, maxPoints?: number) => Promise<unknown[]>

  // 导入导出
  exportSession: (sessionId: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
  importSession: () => Promise<{ success: boolean; session?: unknown; error?: string }>
  deleteSession: (sessionId: string) => Promise<boolean>

  // 工具
  triggerGC: () => Promise<unknown>
  takeHeapSnapshot: (filePath?: string) => Promise<string>
  addMark: (label: string, metadata?: Record<string, unknown>) => Promise<void>
  getConfig: () => Promise<unknown>

  // 数据订阅
  onSnapshot: (callback: (data: unknown) => void) => void
  onAnomaly: (callback: (data: unknown) => void) => void

  // 移除监听器
  removeSnapshotListener: () => void
  removeAnomalyListener: () => void
}

/** 在监控面板的 preload 中注入 API */
export function injectMonitorPanelAPI(): void {
  const api: MonitorPanelAPI = {
    // 会话控制
    startSession: (label: string, description?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_START, { label, description }),
    stopSession: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_STOP),
    getSessions: () =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_SESSIONS),
    getSessionReport: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_REPORT, sessionId),
    compareSessions: (baseId: string, targetId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMPARE, { baseId, targetId }),

    // 数据查询
    getSessionSnapshots: (sessionId: string, startTime?: number, endTime?: number, maxPoints?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_SNAPSHOTS, { sessionId, startTime, endTime, maxPoints }),

    // 导入导出
    exportSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT, sessionId),
    importSession: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_IMPORT),
    deleteSession: (sessionId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),

    // 工具
    triggerGC: () =>
      ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_GC),
    takeHeapSnapshot: (filePath?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.HEAP_SNAPSHOT, filePath),
    addMark: (label: string, metadata?: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC_CHANNELS.MARK, { label, metadata }),
    getConfig: () =>
      ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),

    // 数据订阅
    onSnapshot: (callback: (data: unknown) => void) => {
      ipcRenderer.on(IPC_CHANNELS.SNAPSHOT, (_event, data) => callback(data))
    },
    onAnomaly: (callback: (data: unknown) => void) => {
      ipcRenderer.on(IPC_CHANNELS.ANOMALY, (_event, data) => callback(data))
    },

    // 移除监听器
    removeSnapshotListener: () => {
      ipcRenderer.removeAllListeners(IPC_CHANNELS.SNAPSHOT)
    },
    removeAnomalyListener: () => {
      ipcRenderer.removeAllListeners(IPC_CHANNELS.ANOMALY)
    },
  }

  contextBridge.exposeInMainWorld('monitorAPI', api)
}
