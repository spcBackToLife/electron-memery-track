import { contextBridge, ipcRenderer } from 'electron'

// 暴露给控制面板渲染进程的 API
contextBridge.exposeInMainWorld('browserAPI', {
  // 标签页管理
  openTab: (url: string) => ipcRenderer.invoke('browser:open-tab', url),
  closeTab: (tabId: string) => ipcRenderer.invoke('browser:close-tab', tabId),
  closeAllTabs: () => ipcRenderer.invoke('browser:close-all-tabs'),
  switchTab: (tabId: string) => ipcRenderer.invoke('browser:switch-tab', tabId),
  getTabs: () => ipcRenderer.invoke('browser:get-tabs'),

  // 批量操作
  batchOpen: (urls: string[], delayMs: number) =>
    ipcRenderer.invoke('browser:batch-open', urls, delayMs),

  // 自动测试
  autoTestStart: (options: {
    urls: string[]
    openDelay: number
    closeDelay: number
    rounds: number
  }) => ipcRenderer.invoke('browser:auto-test-start', options),
  autoTestStop: () => ipcRenderer.invoke('browser:auto-test-stop'),

  // 内存信息
  getMemoryInfo: () => ipcRenderer.invoke('browser:get-memory-info'),

  // 事件监听
  onTabsChanged: (
    callback: (tabs: Array<{ id: string; title: string; url: string }>) => void
  ) => {
    ipcRenderer.on('browser:tabs-changed', (_event, tabs) => callback(tabs))
  },
  onAutoTestProgress: (
    callback: (progress: {
      round: number
      totalRounds: number
      phase: string
    }) => void
  ) => {
    ipcRenderer.on('browser:auto-test-progress', (_event, progress) =>
      callback(progress)
    )
  },
  onAutoTestDone: (callback: () => void) => {
    ipcRenderer.on('browser:auto-test-done', () => callback())
  },
})
