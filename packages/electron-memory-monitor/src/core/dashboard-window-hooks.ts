/**
 * 看板窗口：快捷键打开 DevTools、加载失败打日志、可选启动即开控制台
 */
import type { BrowserWindow, Input } from 'electron'

function shouldOpenDevToolsShortcut(input: Input): boolean {
  if (input.type !== 'keyDown') {
    return false
  }
  if (input.key === 'F12') {
    return true
  }
  const k = input.key.toLowerCase()
  if (k !== 'i') {
    return false
  }
  // Windows / Linux: Ctrl+Shift+I（与 Chrome 一致）
  if (input.control && input.shift) {
    return true
  }
  // macOS: Cmd+Option+I
  if (process.platform === 'darwin' && input.meta && input.alt) {
    return true
  }
  return false
}

export function attachDashboardWindowHooks(
  win: BrowserWindow,
  options: { openDevToolsOnStart: boolean },
): void {
  const wc = win.webContents

  wc.on('before-input-event', (event, input) => {
    if (!shouldOpenDevToolsShortcut(input)) {
      return
    }
    event.preventDefault()
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools()
    }
    else {
      wc.openDevTools({ mode: 'detach' })
    }
  })

  wc.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[@electron-memory/monitor] dashboard did-fail-load', code, desc, url)
  })

  let autoOpened = false
  wc.on('did-finish-load', () => {
    if (options.openDevToolsOnStart && !autoOpened) {
      autoOpened = true
      wc.openDevTools({ mode: 'detach' })
    }
  })
}
