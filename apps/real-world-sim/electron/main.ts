/**
 * 场景6：模拟真实业务结构
 * 
 * 目的：接近真实应用的综合内存画像
 * 特点：路由切换、列表渲染、弹窗、模拟 WebSocket
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

// 模拟后端数据推送（类似 WebSocket）
let pushTimer: ReturnType<typeof setInterval> | null = null

ipcMain.handle('sim:start-push', () => {
  if (pushTimer) clearInterval(pushTimer)
  let seq = 0
  pushTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sim:data', {
        seq: seq++,
        timestamp: Date.now(),
        items: Array.from({ length: 10 }, (_, i) => ({
          id: `item-${seq}-${i}`,
          title: `消息 #${seq * 10 + i}`,
          content: '这是一条模拟数据 '.repeat(5),
          timestamp: Date.now(),
        })),
      })
    }
  }, 2000)
})

ipcMain.handle('sim:stop-push', () => {
  if (pushTimer) { clearInterval(pushTimer); pushTimer = null }
})

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'real-world-sim',
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

  monitor.startSession('real-world 基线', '模拟真实业务的综合内存画像')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
