/**
 * 场景1：Electron 裸启动基线
 * 
 * 目的：测量 Electron 启动一个空壳应用的最低内存开销
 * 控制变量：无任何页面加载，无 preload
 */

import { app, BrowserWindow } from 'electron'
import path from 'path'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

// 一行代码接入监控
const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  processLabels: {
    'bare-minimum': '裸启动空壳',
  },
})

let mainWindow: BrowserWindow | null = null

// ====== 进程命名（Windows 任务管理器可见） ======
const APP_NAME = 'BareMinimum'
app.setName(APP_NAME)

// ====== 路径配置（与 browser-sim 保持一致） ======
const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: `${APP_NAME}-Renderer`,
  })

  // 开发模式用 Vite dev server，生产模式加载打包后的 dist/index.html
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

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
