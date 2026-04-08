/**
 * 场景1：Electron 裸启动基线
 * 
 * 目的：测量 Electron 启动一个空壳应用的最低内存开销
 * 控制变量：无任何页面加载，无 preload
 */

import { app, BrowserWindow } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

// 一行代码接入监控
const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  processLabels: {
    'bare-minimum': '裸启动空壳',
  },
})

let mainWindow: BrowserWindow | null = null

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: 'bare-minimum',
  })

  // 只加载空白页，不加载任何实际内容
  mainWindow.loadURL('about:blank')

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 自动开始一个测试会话
  monitor.startSession('bare-minimum 基线', 'Electron 裸启动内存基线测试')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
