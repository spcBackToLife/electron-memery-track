/**
 * 场景4：重渲染场景
 * 
 * 目的：测量大量 DOM/Canvas/动画对渲染进程内存的影响
 */

import { app, BrowserWindow } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'
import path from 'path'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
})

let mainWindow: BrowserWindow | null = null

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'heavy-renderer',
    webPreferences: {
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

  monitor.startSession('heavy-renderer 基线', '重渲染场景内存基线')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
