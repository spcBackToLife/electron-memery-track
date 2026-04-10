/**
 * browser-sim-test：对齐 launcher multi-window
 * - 主壳 WebContentsView ≈ win-manager 里 BrowserWindow 的 webPreferences
 * - 标签 WebContentsView ≈ tab-manager.addTab（persist:multi-window、tab-preload、无 sandbox）
 * - 标签显隐 ≈ setActiveTabAndHideOthers：当前正常 bounds，其余 0×0（不移除子 View）
 *
 * 参考：
 * - D:\work\launcher\...\win-manager.ts（主窗 webPreferences）
 * - D:\work\launcher\...\tab-manager.ts（addTab、resize、412、window.open）
 *
 * Windows 白屏 + 子进程 exitCode=18：多与 GPU 进程启动失败有关（如 electron#38264）。
 * 与 launcher 同环境对比前可在**启动进程前**设置：
 * - BROWSER_SIM_TEST_DISABLE_HW_ACCEL=1     → app.disableHardwareAcceleration()
 * - BROWSER_SIM_TEST_DISABLE_GPU_SANDBOX=1  → --disable-gpu-sandbox
 */

import { app, BaseWindow, WebContentsView, ipcMain, session } from 'electron'
import { ElectronMemoryMonitor } from '@electron-memory/monitor'
import path from 'path'

if (process.env.BROWSER_SIM_TEST_DISABLE_HW_ACCEL === '1') {
  app.disableHardwareAcceleration()
}
if (process.env.BROWSER_SIM_TEST_DISABLE_GPU_SANDBOX === '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

const __dirname_electron = path.dirname(__filename)
const RENDERER_DIST = path.join(__dirname_electron, '../dist')
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/** launcher FixedTabHeaderHeight=40；本应用工具区更高，仅保留「内容区顶偏移」语义 */
const SHELL_HEADER_HEIGHT = 140

/** launcher tab-manager 与 addTab 使用的 partition */
const MULTI_WINDOW_PARTITION = 'persist:multi-window'

const monitor = new ElectronMemoryMonitor({
  openDashboardOnStart: true,
  enableRendererDetail: true,
  session: {
    autoStartOnLaunch: true,
    autoLabelPrefix: 'browser-sim-test',
    autoDescription: '与 launcher 对齐的壳 + 标签页场景；自动测试仅打标不新开/结束会话',
  },
  processLabels: {
    'Browser Sim Test': '浏览器模拟测试',
  },
})

let mainWindow: BaseWindow | null = null
let controlView: WebContentsView | null = null
const tabViews = new Map<string, WebContentsView>()
let tabIdCounter = 0
/** 当前激活标签（与 launcher win.currentTab 对应） */
let currentTabId: string | null = null

function broadcastProcessDiagnostic(payload: Record<string, unknown>) {
  const line = `${new Date().toISOString()} ${JSON.stringify(payload)}`
  console.error('[browser-sim-test][process-diagnostic]', line)
  try {
    if (controlView && !controlView.webContents.isDestroyed()) {
      controlView.webContents.send('browser:process-diagnostic', {
        ...payload,
        line,
      })
    }
  } catch {
    // ignore
  }
}

app.on('child-process-gone', (_event, details) => {
  broadcastProcessDiagnostic({
    event: 'child-process-gone',
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
  })
})

app.on('render-process-gone', (_event, webContents, details) => {
  broadcastProcessDiagnostic({
    event: 'render-process-gone',
    reason: details.reason,
    exitCode: details.exitCode,
    webContentsId: webContents.id,
  })
})

let isSessionConfigured = false

function ensureMultiWindowSession() {
  if (isSessionConfigured) return
  isSessionConfigured = true
  const ses = session.fromPartition(MULTI_WINDOW_PARTITION)
  const standardUA = ses
    .getUserAgent()
    .replace(/ [\w-]+\/[\d.]+(?= Chrome\/)/, '')
    .replace(/ Electron\/[\d.]+/, '')
  ses.setUserAgent(standardUA)
}

/** 对齐 launcher BuildType !== Release 时开 DevTools */
const devToolsEnabled = !app.isPackaged

/** win-manager BrowserWindow.webPreferences */
function shellWebPreferences(): Electron.WebPreferences {
  return {
    disableBlinkFeatures: 'Auxclick',
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
    devTools: devToolsEnabled,
    webviewTag: false,
    backgroundThrottling: false,
    preload: path.join(__dirname_electron, 'preload.js'),
  }
}

/** tab-manager addTab 内 WebContentsView.webPreferences */
function tabWebPreferences(): Electron.WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    partition: MULTI_WINDOW_PARTITION,
    preload: path.join(__dirname_electron, 'tab-preload.js'),
    devTools: devToolsEnabled,
  }
}

function destroyTabWebContents(wc: Electron.WebContents) {
  if (!wc || wc.isDestroyed()) return
  const destroy = (wc as unknown as { destroy?: () => void }).destroy
  if (typeof destroy === 'function') {
    destroy.call(wc)
  } else {
    wc.close()
  }
}

function collectTabsPayload(): Array<{ id: string; title: string; url: string }> {
  const tabs: Array<{ id: string; title: string; url: string }> = []
  for (const [id, view] of tabViews) {
    try {
      if (view.webContents.isDestroyed()) continue
      tabs.push({
        id,
        title: view.webContents.getTitle() || 'Untitled',
        url: view.webContents.getURL(),
      })
    } catch {
      // ignore
    }
  }
  return tabs
}

function notifyTabsChanged() {
  if (!controlView || controlView.webContents.isDestroyed()) return
  controlView.webContents.send('browser:tabs-changed', {
    tabs: collectTabsPayload(),
    activeTabId: currentTabId,
  })
}

/** 与 tab-manager.setActiveTabAndHideOthers 一致 */
function setActiveTabAndHideOthers(tabId: string | null) {
  currentTabId = tabId
  if (!mainWindow) return
  const [w, h] = mainWindow.getContentSize()
  for (const [id, view] of tabViews) {
    if (id === tabId) {
      if (!mainWindow.contentView.children.includes(view)) {
        mainWindow.contentView.addChildView(view)
      }
      view.setBounds({
        x: 0,
        y: SHELL_HEADER_HEIGHT,
        width: w,
        height: Math.max(h - SHELL_HEADER_HEIGHT, 1),
      })
    } else {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }
  notifyTabsChanged()
}

function relayoutTabBoundsOnly() {
  if (!mainWindow) return
  const [w, h] = mainWindow.getContentSize()
  for (const [id, view] of tabViews) {
    if (id === currentTabId) {
      view.setBounds({
        x: 0,
        y: SHELL_HEADER_HEIGHT,
        width: w,
        height: Math.max(h - SHELL_HEADER_HEIGHT, 1),
      })
    } else {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }
}

function updateLayout() {
  if (!mainWindow || !controlView) return
  const { width, height } = mainWindow.getContentBounds()
  controlView.setBounds({
    x: 0,
    y: 0,
    width,
    height: SHELL_HEADER_HEIGHT,
  })
  relayoutTabBoundsOnly()
}

function registerTabLifecycle(view: WebContentsView, tabId: string) {
  const wc = view.webContents

  let antiBlockRetries = 0
  wc.on('did-navigate', (_e, _url, httpResponseCode) => {
    if (httpResponseCode === 412 && antiBlockRetries < 2) {
      antiBlockRetries += 1
      setTimeout(() => {
        if (!wc.isDestroyed()) wc.reload()
      }, 1500)
    } else if (httpResponseCode >= 200 && httpResponseCode < 400) {
      antiBlockRetries = 0
    }
  })

  wc.on('page-title-updated', () => {
    notifyTabsChanged()
  })

  wc.on('before-input-event', (event, input) => {
    if (input.code === 'F5' || (input.control && input.key === 'r')) {
      refreshTab(tabId)
      event.preventDefault()
    }
  })

  wc.on('enter-html-full-screen', () => {
    if (!mainWindow) return
    const [width, height] = mainWindow.getContentSize()
    view.setBounds({ x: 0, y: 0, width, height })
  })

  wc.on('leave-html-full-screen', () => {
    if (currentTabId === tabId) relayoutTabBoundsOnly()
  })

  wc.setWindowOpenHandler((details) => {
    const targetUrl = details.url
    if (targetUrl) {
      void addTabFromMain(targetUrl, targetUrl)
    }
    return { action: 'deny' }
  })
}

function refreshTab(tabId: string) {
  const view = tabViews.get(tabId)
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.reload()
  }
}

function validateHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

async function addTabFromMain(
  url: string,
  titleHint: string
): Promise<{ tabId: string; title: string; url: string } | null> {
  if (!mainWindow) return null
  ensureMultiWindowSession()

  const shouldLoad = validateHttpUrl(url)
  const tabId = `tab-${++tabIdCounter}`
  const tabView = new WebContentsView({ webPreferences: tabWebPreferences() })

  tabViews.set(tabId, tabView)
  mainWindow.contentView.addChildView(tabView)
  registerTabLifecycle(tabView, tabId)

  setActiveTabAndHideOthers(tabId)

  if (shouldLoad) {
    try {
      await tabView.webContents.loadURL(url)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Tab ${tabId}] 加载失败: ${url}`, msg)
    }
  }

  const title =
    !tabView.webContents.isDestroyed() && tabView.webContents.getTitle()
      ? tabView.webContents.getTitle()
      : titleHint

  notifyTabsChanged()
  return { tabId, title, url }
}

function createMainWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Browser Sim Test (launcher-aligned)',
  })

  controlView = new WebContentsView({
    webPreferences: shellWebPreferences(),
  })

  mainWindow.contentView.addChildView(controlView)

  if (VITE_DEV_SERVER_URL) {
    controlView.webContents.loadURL(VITE_DEV_SERVER_URL)
  } else {
    controlView.webContents.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  updateLayout()

  mainWindow.on('resize', () => {
    updateLayout()
  })

  mainWindow.on('closed', () => {
    for (const [_id, view] of tabViews) {
      try {
        destroyTabWebContents(view.webContents)
      } catch {
        // ignore
      }
    }
    tabViews.clear()
    currentTabId = null
    controlView = null
    mainWindow = null
  })
}

// ===== IPC =====

ipcMain.handle('browser:open-tab', async (_event, url: string) => {
  let u = url.trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return addTabFromMain(u, u)
})

ipcMain.handle('browser:close-tab', async (_event, tabId: string) => {
  const view = tabViews.get(tabId)
  if (!view || !mainWindow) return false

  const ordered = [...tabViews.keys()]
  const idx = ordered.indexOf(tabId)
  let nextActive: string | null = null
  if (tabViews.size > 1) {
    if (idx === 0) nextActive = ordered[1]
    else nextActive = ordered[idx - 1]
  }

  if (mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.removeChildView(view)
  }
  destroyTabWebContents(view.webContents)
  tabViews.delete(tabId)

  if (currentTabId === tabId) {
    currentTabId = null
    setActiveTabAndHideOthers(nextActive)
  } else {
    notifyTabsChanged()
  }

  return true
})

ipcMain.handle('browser:close-all-tabs', async () => {
  if (!mainWindow) return false

  for (const [_id, view] of tabViews) {
    if (mainWindow.contentView.children.includes(view)) {
      mainWindow.contentView.removeChildView(view)
    }
    destroyTabWebContents(view.webContents)
  }
  tabViews.clear()
  currentTabId = null
  notifyTabsChanged()
  return true
})

ipcMain.handle('browser:switch-tab', async (_event, tabId: string) => {
  if (!tabViews.has(tabId)) return false
  setActiveTabAndHideOthers(tabId)
  refreshTab(tabId)
  return true
})

ipcMain.handle('browser:get-tabs', () => ({
  tabs: collectTabsPayload(),
  activeTabId: currentTabId,
}))

ipcMain.handle(
  'browser:batch-open',
  async (_event, urls: string[], delayMs: number) => {
    const results: Array<{ tabId: string; title: string; url: string }> = []

    for (const raw of urls) {
      if (!mainWindow) break
      let u = raw.trim()
      if (!u) continue
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u

      const r = await addTabFromMain(u, u)
      if (r) results.push(r)

      if (delayMs > 0) {
        await new Promise((r2) => setTimeout(r2, delayMs))
      }
    }

    return results
  }
)

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

    monitor.mark('autotest:start', { rounds, urlCount: urls.length, openDelay, closeDelay })

    try {
      for (let round = 0; round < rounds; round++) {
        if (signal.aborted) break

        controlView?.webContents.send('browser:auto-test-progress', {
          round: round + 1,
          totalRounds: rounds,
          phase: 'opening',
        })

        monitor.mark(`autotest:r${round + 1}-before-open`, { round: round + 1, totalRounds: rounds })

        const openedTabs: string[] = []
        for (const raw of urls) {
          if (signal.aborted) break
          let u = raw.trim()
          if (!u) continue
          if (!/^https?:\/\//i.test(u)) u = 'https://' + u

          const r = await addTabFromMain(u, u)
          if (r) openedTabs.push(r.tabId)

          if (openDelay > 0) {
            await sleep(openDelay, signal)
          }
        }

        monitor.mark(`autotest:r${round + 1}-all-tabs-open`, {
          round: round + 1,
          openedCount: openedTabs.length,
        })

        controlView?.webContents.send('browser:auto-test-progress', {
          round: round + 1,
          totalRounds: rounds,
          phase: 'closing',
        })

        monitor.mark(`autotest:r${round + 1}-before-close`, { round: round + 1 })

        for (const tabId of openedTabs) {
          if (signal.aborted) break

          const view = tabViews.get(tabId)
          if (view && mainWindow) {
            if (mainWindow.contentView.children.includes(view)) {
              mainWindow.contentView.removeChildView(view)
            }
            destroyTabWebContents(view.webContents)
            tabViews.delete(tabId)
            if (currentTabId === tabId) currentTabId = null
            notifyTabsChanged()

            if (closeDelay > 0) {
              await sleep(closeDelay, signal)
            }
          }
        }

        const remaining = [...tabViews.keys()]
        if (remaining.length > 0) {
          setActiveTabAndHideOthers(remaining[remaining.length - 1])
        } else {
          notifyTabsChanged()
        }

        monitor.mark(`autotest:r${round + 1}-after-close`, { round: round + 1 })
      }
    } catch {
      // abort
    }

    const autotestAborted = signal.aborted
    autoTestRunning = false
    autoTestAbortController = null

    monitor.mark('autotest:stop', { aborted: autotestAborted })

    controlView?.webContents.send('browser:auto-test-done')
    return { success: true }
  }
)

ipcMain.handle('browser:auto-test-stop', () => {
  autoTestAbortController?.abort()
  return true
})

ipcMain.handle('browser:get-launch-env', () => ({
  disableHardwareAcceleration: process.env.BROWSER_SIM_TEST_DISABLE_HW_ACCEL === '1',
  disableGpuSandboxSwitch: process.env.BROWSER_SIM_TEST_DISABLE_GPU_SANDBOX === '1',
  /** 便于与 launcher 启动参数对照 */
  argv: process.argv.slice(1),
}))

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

let memoryMonitorQuitHandled = false
app.on('before-quit', (e) => {
  if (memoryMonitorQuitHandled) return
  memoryMonitorQuitHandled = true
  e.preventDefault()
  void (async () => {
    try {
      await monitor.stopSession()
    } catch (err) {
      console.error('[browser-sim-test] 退出时 stopSession:', err)
    }
    app.exit(0)
  })()
})

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
