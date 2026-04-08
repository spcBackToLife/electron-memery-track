/**
 * IPC 主进程处理器
 * 
 * 注册所有 emm:* IPC 通道的 handler
 * 桥接监控面板（渲染进程）与 SDK 核心（主进程）
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from './channels'
import type { ElectronMemoryMonitor } from '../core/monitor'

export class IPCMainHandler {
  private monitor: ElectronMemoryMonitor

  constructor(monitor: ElectronMemoryMonitor) {
    this.monitor = monitor
  }

  /** 注册所有 IPC handlers */
  register(): void {
    // 会话控制
    ipcMain.handle(IPC_CHANNELS.SESSION_START, (_event, args: { label: string; description?: string }) => {
      return this.monitor.startSession(args.label, args.description)
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_STOP, async () => {
      return this.monitor.stopSession()
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
      return this.monitor.getSessions()
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_REPORT, async (_event, sessionId: string) => {
      return this.monitor.getSessionReport(sessionId)
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_COMPARE, async (_event, args: { baseId: string; targetId: string }) => {
      return this.monitor.compareSessions(args.baseId, args.targetId)
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_SNAPSHOTS, async (_event, args: { sessionId: string; startTime?: number; endTime?: number; maxPoints?: number }) => {
      return this.monitor.getSessionSnapshots(args.sessionId, args.startTime, args.endTime, args.maxPoints)
    })

    // 工具操作
    ipcMain.handle(IPC_CHANNELS.TRIGGER_GC, async () => {
      return this.monitor.triggerGC()
    })

    ipcMain.handle(IPC_CHANNELS.HEAP_SNAPSHOT, async (_event, filePath?: string) => {
      return this.monitor.takeHeapSnapshot(filePath)
    })

    ipcMain.handle(IPC_CHANNELS.MARK, (_event, args: { label: string; metadata?: Record<string, unknown> }) => {
      this.monitor.mark(args.label, args.metadata)
    })

    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
      return this.monitor.getConfig()
    })

    ipcMain.handle(IPC_CHANNELS.GET_SESSIONS, async () => {
      return this.monitor.getSessions()
    })

    // 导入导出
    ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_event, sessionId: string) => {
      return this.monitor.exportSession(sessionId)
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async () => {
      return this.monitor.importSession()
    })

    ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
      return this.monitor.deleteSession(sessionId)
    })

    // 渲染进程上报（可选）
    ipcMain.on(IPC_CHANNELS.RENDERER_REPORT, (_event, detail) => {
      this.monitor.updateRendererDetail(detail)
    })
  }

  /** 向监控面板推送快照数据 */
  pushSnapshot(dashboardWindow: BrowserWindow | null, data: unknown): void {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IPC_CHANNELS.SNAPSHOT, data)
    }
  }

  /** 向监控面板推送异常事件 */
  pushAnomaly(dashboardWindow: BrowserWindow | null, data: unknown): void {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IPC_CHANNELS.ANOMALY, data)
    }
  }

  /** 移除所有注册的 handlers */
  unregister(): void {
    const channels = Object.values(IPC_CHANNELS)
    for (const channel of channels) {
      ipcMain.removeHandler(channel)
      ipcMain.removeAllListeners(channel)
    }
  }
}
