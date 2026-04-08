/**
 * 场景5：IPC 高频通信压力测试
 * 
 * 目的：测量不同频率、不同数据量的 IPC 通信对内存的影响
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'
import path from 'path'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
})

let mainWindow: BrowserWindow | null = null

// IPC 压力测试 handler
let ipcTimer: ReturnType<typeof setInterval> | null = null

ipcMain.handle('ipc-stress:start', (_event, config: { interval: number; dataSize: number }) => {
  if (ipcTimer) clearInterval(ipcTimer)

  // 主进程主动向渲染进程推送大量数据
  ipcTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const data = Buffer.alloc(config.dataSize, 'A').toString()
      mainWindow.webContents.send('ipc-stress:data', {
        timestamp: Date.now(),
        payload: data,
        size: config.dataSize,
      })
    }
  }, config.interval)

  return { status: 'started', interval: config.interval, dataSize: config.dataSize }
})

ipcMain.handle('ipc-stress:stop', () => {
  if (ipcTimer) {
    clearInterval(ipcTimer)
    ipcTimer = null
  }
  return { status: 'stopped' }
})

// 渲染进程 → 主进程的压力测试
ipcMain.handle('ipc-stress:echo', (_event, data: unknown) => {
  return data // 原样返回
})

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'ipc-stress',
    webPreferences: {
      preload: path.join(__dirname_electron, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  monitor.startSession('ipc-stress 基线', 'IPC 高频通信压力测试')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
