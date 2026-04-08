import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'

// 开发环境下的 dist-electron 目录
const __dirname_electron = path.dirname(__filename)

// dist 目录，用于生产环境加载渲染进程页面
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
// Vite 开发服务器 URL
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname_electron, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  // 窗口准备好后再显示，避免白屏闪烁
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (VITE_DEV_SERVER_URL) {
    // 开发模式：加载 Vite 开发服务器
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
    // 自动打开 DevTools
    mainWindow.webContents.openDevTools()
  } else {
    // 生产模式：加载打包后的 HTML
    mainWindow.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// IPC 通信示例：获取应用信息
ipcMain.handle('get-app-info', () => {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform
  }
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    // macOS 下点击 dock 图标时重新创建窗口
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
