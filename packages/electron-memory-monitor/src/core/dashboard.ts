/**
 * DashboardManager - 监控面板窗口管理
 * 
 * 创建和管理独立的监控面板 BrowserWindow
 * 面板 UI 预编译为静态资源，打包在 SDK 内
 */

import { BrowserWindow } from 'electron'
import * as path from 'path'
import type { MonitorConfig } from '../types/config'

export class DashboardManager {
  private config: MonitorConfig
  private window: BrowserWindow | null = null

  constructor(config: MonitorConfig) {
    this.config = config
  }

  /** 获取面板窗口 */
  getWindow(): BrowserWindow | null {
    return this.window
  }

  /** 获取面板 webContents ID */
  getWebContentsId(): number | null {
    if (this.window && !this.window.isDestroyed()) {
      return this.window.webContents.id
    }
    return null
  }

  /** 打开监控面板 */
  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus()
      return
    }

    // 创建 preload 脚本路径
    const preloadPath = path.join(__dirname, 'dashboard-preload.js')

    this.window = new BrowserWindow({
      width: this.config.dashboard.width,
      height: this.config.dashboard.height,
      title: 'Electron Memory Monitor',
      alwaysOnTop: this.config.dashboard.alwaysOnTop,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // 加载面板 UI
    const uiPath = path.join(__dirname, 'ui', 'index.html')
    this.window.loadFile(uiPath)

    this.window.on('closed', () => {
      this.window = null
    })
  }

  /** 关闭监控面板 */
  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close()
      this.window = null
    }
  }

  /** 销毁面板 */
  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
      this.window = null
    }
  }
}
