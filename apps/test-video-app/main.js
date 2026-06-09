const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: true,
    autoHideMenuBar: true,   // 隐藏默认菜单栏（按 Alt 才显示）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 允许 file:// 协议加载本地视频
      webSecurity: false,
    },
  })

  win.setMenu(null)  // 完全去掉菜单栏
  win.loadFile('index.html')
  // 打开 DevTools 方便调试
  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
