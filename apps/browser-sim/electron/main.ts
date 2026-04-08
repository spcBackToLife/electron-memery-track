/**
 * 场景7：浏览器模拟器
 *
 * 目的：使用 WebContentsView 模拟浏览器标签页，测试持续打开/关闭页面时的内存变化
 * 核心测试点：
 *   1. 每次通过 WebContentsView 打开一个新页面时，内存增量多少
 *   2. 关闭 WebContentsView 后，内存是否能被回收
 *   3. 长时间反复打开/关闭后，是否存在内存泄漏
 *
 * 架构说明：
 *   - 使用 BaseWindow + WebContentsView 组合（Electron 30+ 推荐方式）
 *   - 顶部区域由一个固定的 WebContentsView 渲染控制面板 UI（React）
 *   - 下方区域由动态创建/销毁的 WebContentsView 加载外部网页
 */

import { app, BaseWindow, WebContentsView, ipcMain, session } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'
import path from 'path'

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

// ===== 内存监控 =====
const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  processLabels: {
    'Browser Simulator': '浏览器模拟器',
  },
})

// ===== 全局状态 =====
let mainWindow: BaseWindow | null = null
let controlView: WebContentsView | null = null

// 存储所有打开的标签页 { id -> WebContentsView }
const tabViews = new Map<string, WebContentsView>()
let tabIdCounter = 0

// 控制面板高度
const TOOLBAR_HEIGHT = 140

// ===== 创建主窗口 =====
function createMainWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Browser Simulator - Memory Test',
  })

  // 创建控制面板视图（固定在顶部）
  controlView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname_electron, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.contentView.addChildView(controlView)

  // 加载控制面板 UI
  if (VITE_DEV_SERVER_URL) {
    controlView.webContents.loadURL(VITE_DEV_SERVER_URL)
  } else {
    controlView.webContents.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  // 布局
  updateLayout()

  mainWindow.on('resize', () => {
    updateLayout()
  })

  mainWindow.on('closed', () => {
    // 清理所有标签页
    for (const [id, view] of tabViews) {
      try {
        view.webContents.close()
      } catch (_e) {
        // ignore
      }
    }
    tabViews.clear()
    controlView = null
    mainWindow = null
  })
}

// ===== 布局管理 =====
function updateLayout() {
  if (!mainWindow || !controlView) return

  const { width, height } = mainWindow.getContentBounds()

  // 控制面板固定在顶部
  controlView.setBounds({
    x: 0,
    y: 0,
    width: width,
    height: TOOLBAR_HEIGHT,
  })

  // 当前活跃的标签页占据剩余空间
  for (const [_id, view] of tabViews) {
    view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: width,
      height: Math.max(height - TOOLBAR_HEIGHT, 100),
    })
  }
}

// ===== 显示指定标签页，隐藏其他 =====
function showTab(tabId: string) {
  if (!mainWindow) return

  for (const [id, view] of tabViews) {
    if (id === tabId) {
      // 确保这个 view 在 contentView 中
      if (!mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.addChildView(view)
      }
      const { width, height } = mainWindow.getContentBounds()
      view.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: width,
        height: Math.max(height - TOOLBAR_HEIGHT, 100),
      })
    } else {
      // 移除其他标签页的视图（不销毁）
      if (mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.removeChildView(view)
      }
    }
  }
}

// ===== IPC Handlers =====

// 打开新标签页
ipcMain.handle('browser:open-tab', async (_event, url: string) => {
  if (!mainWindow) return null

  const tabId = `tab-${++tabIdCounter}`

  const tabView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  tabViews.set(tabId, tabView)

  // 先隐藏其他标签页，显示新的
  showTab(tabId)

  // 加载 URL
  try {
    await tabView.webContents.loadURL(url)
  } catch (err: any) {
    console.error(`[Tab ${tabId}] 加载失败: ${url}`, err.message)
  }

  // 获取标题
  const title = tabView.webContents.getTitle() || url

  // 通知控制面板标签页已打开
  notifyTabsChanged()

  return { tabId, title, url }
})

// 关闭标签页
ipcMain.handle('browser:close-tab', async (_event, tabId: string) => {
  const view = tabViews.get(tabId)
  if (!view || !mainWindow) return false

  // 从窗口移除
  if (mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.removeChildView(view)
  }

  // 关闭 webContents 释放内存
  view.webContents.close()
  tabViews.delete(tabId)

  // 如果还有其他标签页，显示最后一个
  const remaining = Array.from(tabViews.keys())
  if (remaining.length > 0) {
    showTab(remaining[remaining.length - 1])
  }

  notifyTabsChanged()
  return true
})

// 关闭所有标签页
ipcMain.handle('browser:close-all-tabs', async () => {
  if (!mainWindow) return false

  for (const [_id, view] of tabViews) {
    if (mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.removeChildView(view)
    }
    view.webContents.close()
  }
  tabViews.clear()

  notifyTabsChanged()
  return true
})

// 切换标签页
ipcMain.handle('browser:switch-tab', async (_event, tabId: string) => {
  if (!tabViews.has(tabId)) return false
  showTab(tabId)
  return true
})

// 获取标签页列表
ipcMain.handle('browser:get-tabs', () => {
  const tabs: Array<{ id: string; title: string; url: string }> = []
  for (const [id, view] of tabViews) {
    tabs.push({
      id,
      title: view.webContents.getTitle() || 'Untitled',
      url: view.webContents.getURL(),
    })
  }
  return tabs
})

// 批量打开标签页（用于压力测试）
ipcMain.handle(
  'browser:batch-open',
  async (_event, urls: string[], delayMs: number) => {
    const results: Array<{ tabId: string; title: string; url: string }> = []

    for (const url of urls) {
      if (!mainWindow) break

      const tabId = `tab-${++tabIdCounter}`
      const tabView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })

      tabViews.set(tabId, tabView)
      showTab(tabId)

      try {
        await tabView.webContents.loadURL(url)
      } catch (err: any) {
        console.error(`[Tab ${tabId}] 加载失败: ${url}`, err.message)
      }

      results.push({
        tabId,
        title: tabView.webContents.getTitle() || url,
        url,
      })

      notifyTabsChanged()

      // 延迟
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }

    return results
  }
)

// 自动测试：循环打开和关闭
let autoTestRunning = false
let autoTestAbortController: AbortController | null = null

ipcMain.handle(
  'browser:auto-test-start',
  async (
    _event,
    options: {
      urls: string[]
      openDelay: number
      closeDelay: number
      rounds: number
    }
  ) => {
    if (autoTestRunning) return { error: 'Auto test already running' }

    autoTestRunning = true
    autoTestAbortController = new AbortController()
    const { signal } = autoTestAbortController

    const { urls, openDelay, closeDelay, rounds } = options

    // 开始一个监控会话
    monitor.startSession(
      `browser-sim-autotest-r${rounds}`,
      `自动测试: ${rounds} 轮, ${urls.length} 个URL, 打开间隔${openDelay}ms, 关闭间隔${closeDelay}ms`
    )

    try {
      for (let round = 0; round < rounds; round++) {
        if (signal.aborted) break

        // 通知当前轮次
        controlView?.webContents.send('browser:auto-test-progress', {
          round: round + 1,
          totalRounds: rounds,
          phase: 'opening',
        })

        // 打开所有 URL
        const openedTabs: string[] = []
        for (const url of urls) {
          if (signal.aborted) break

          const tabId = `tab-${++tabIdCounter}`
          const tabView = new WebContentsView({
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
            },
          })

          tabViews.set(tabId, tabView)
          showTab(tabId)

          try {
            await tabView.webContents.loadURL(url)
          } catch (_err) {
            // ignore load errors
          }

          openedTabs.push(tabId)
          notifyTabsChanged()

          if (openDelay > 0) {
            await sleep(openDelay, signal)
          }
        }

        // 通知进入关闭阶段
        controlView?.webContents.send('browser:auto-test-progress', {
          round: round + 1,
          totalRounds: rounds,
          phase: 'closing',
        })

        // 关闭刚才打开的所有标签页
        for (const tabId of openedTabs) {
          if (signal.aborted) break

          const view = tabViews.get(tabId)
          if (view && mainWindow) {
            if (mainWindow.contentView.children.includes(view)) {
              mainWindow.contentView.removeChildView(view)
            }
            view.webContents.close()
            tabViews.delete(tabId)
            notifyTabsChanged()

            if (closeDelay > 0) {
              await sleep(closeDelay, signal)
            }
          }
        }
      }
    } catch (err) {
      // abort or other error
    }

    autoTestRunning = false
    autoTestAbortController = null

    // 结束监控会话
    try {
      await monitor.stopSession()
    } catch (_e) {
      // ignore
    }

    controlView?.webContents.send('browser:auto-test-done')
    return { success: true }
  }
)

ipcMain.handle('browser:auto-test-stop', () => {
  if (autoTestAbortController) {
    autoTestAbortController.abort()
  }
  return true
})

// 获取内存信息
ipcMain.handle('browser:get-memory-info', () => {
  const metrics = app.getAppMetrics()
  return {
    tabCount: tabViews.size,
    processCount: metrics.length,
    totalMemory: metrics.reduce(
      (sum, m) => sum + (m.memory?.workingSetSize || 0),
      0
    ),
    mainProcessMemory: process.memoryUsage(),
    metrics: metrics.map((m) => ({
      pid: m.pid,
      type: m.type,
      memory: m.memory,
      cpu: m.cpu,
    })),
  }
})

// ===== Helper =====
function notifyTabsChanged() {
  if (!controlView) return
  const tabs: Array<{ id: string; title: string; url: string }> = []
  for (const [id, view] of tabViews) {
    try {
      tabs.push({
        id,
        title: view.webContents.getTitle() || 'Untitled',
        url: view.webContents.getURL(),
      })
    } catch (_e) {
      // webContents may be destroyed
    }
  }
  controlView.webContents.send('browser:tabs-changed', tabs)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Aborted'))
        },
        { once: true }
      )
    }
  })
}

// ===== App Lifecycle =====
app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
