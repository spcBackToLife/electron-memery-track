/**
 * 场景2：单窗口空白 React 页面
 * 
 * 目的：测量一个空白 React 渲染页面额外增加多少内存
 * 控制变量：一个窗口 + React 空白页 + preload
 */

import { app, BrowserWindow } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'
import path from 'path'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// 一行代码接入监控
const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  processLabels: {
    'single-window': '单窗口空白页',
  },
})

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'single-window',
    webPreferences: {
      preload: path.join(__dirname_electron, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  // 自动开始测试会话
  monitor.startSession('single-window 基线', '单窗口空白 React 页面内存基线')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
