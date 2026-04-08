/**
 * 场景3：多窗口场景
 * 
 * 目的：测量每多一个窗口的内存增量，边际成本
 * 控制变量：通过 WINDOW_COUNT 环境变量控制窗口数量（默认 5）
 */

import { app, BrowserWindow } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

const WINDOW_COUNT = parseInt(process.env.WINDOW_COUNT || '5')

const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  processLabels: Object.fromEntries(
    Array.from({ length: WINDOW_COUNT }, (_, i) => [`Window ${i + 1}`, `窗口${i + 1}`])
  ),
})

const windows: BrowserWindow[] = []

app.whenReady().then(() => {
  // 按网格排列窗口
  const cols = Math.ceil(Math.sqrt(WINDOW_COUNT))
  const winWidth = 400
  const winHeight = 300

  for (let i = 0; i < WINDOW_COUNT; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols

    const win = new BrowserWindow({
      width: winWidth,
      height: winHeight,
      x: col * (winWidth + 10) + 50,
      y: row * (winHeight + 10) + 50,
      title: `Window ${i + 1}`,
    })

    win.loadURL('about:blank')

    // 在空白页中显示窗口编号
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        document.body.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;font-size:24px;'
        document.body.innerHTML = '<div style="text-align:center"><div style="font-size:48px;margin-bottom:8px">🪟</div>Window ${i + 1}</div>'
      `)
    })

    windows.push(win)

    win.on('closed', () => {
      const idx = windows.indexOf(win)
      if (idx >= 0) windows.splice(idx, 1)
    })
  }

  monitor.startSession(
    `multi-window × ${WINDOW_COUNT}`,
    `${WINDOW_COUNT} 个空白窗口的内存基线测试`
  )
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
