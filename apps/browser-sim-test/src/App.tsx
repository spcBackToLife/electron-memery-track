import React, { useState, useEffect, useCallback, useRef } from 'react'
import type {
  Tab,
  AutoTestProgress,
  MemoryInfo,
  LaunchEnvInfo,
} from './types/browser.d'

const PRESET_URLS = [
  'https://www.baidu.com',
  'https://www.bing.com',
  'https://github.com',
  'https://developer.mozilla.org',
  'https://www.wikipedia.org',
  'https://news.ycombinator.com',
  'https://stackoverflow.com',
  'https://www.npmjs.com',
  'https://reactjs.org',
  'https://nodejs.org',
]

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState('https://www.baidu.com')
  const [memoryInfo, setMemoryInfo] = useState<MemoryInfo | null>(null)
  const [autoTestRunning, setAutoTestRunning] = useState(false)
  const [autoTestProgress, setAutoTestProgress] = useState<AutoTestProgress | null>(null)
  const [memoryHistory, setMemoryHistory] = useState<Array<{ time: number; memory: number; tabs: number }>>([])

  const [testRounds, setTestRounds] = useState(5)
  const [testOpenDelay, setTestOpenDelay] = useState(1000)
  const [testCloseDelay, setTestCloseDelay] = useState(500)
  const [testUrls, setTestUrls] = useState(PRESET_URLS.slice(0, 5).join('\n'))

  const [launchEnv, setLaunchEnv] = useState<LaunchEnvInfo | null>(null)
  const [lastProcessDiagnostic, setLastProcessDiagnostic] = useState<string | null>(null)

  const memoryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const api = window.browserAPI
    if (!api) return

    void api.getTabs().then(({ tabs: t, activeTabId: a }) => {
      setTabs(t)
      setActiveTabId(a)
    })

    void api.getLaunchEnv().then(setLaunchEnv)

    api.onProcessDiagnostic((payload) => {
      const text =
        typeof payload.line === 'string'
          ? payload.line
          : JSON.stringify(payload)
      setLastProcessDiagnostic(text)
    })

    api.onTabsChanged(({ tabs: newTabs, activeTabId: next }) => {
      setTabs(newTabs)
      setActiveTabId(next)
    })

    api.onAutoTestProgress((progress) => {
      setAutoTestProgress(progress)
    })

    api.onAutoTestDone(() => {
      setAutoTestRunning(false)
      setAutoTestProgress(null)
    })
  }, [])

  useEffect(() => {
    const fetchMemory = async () => {
      try {
        const info = await window.browserAPI.getMemoryInfo()
        setMemoryInfo(info)
        setMemoryHistory((prev) => {
          const next = [
            ...prev,
            { time: Date.now(), memory: info.totalMemory, tabs: info.tabCount },
          ]
          return next.slice(-300)
        })
      } catch {
        // ignore
      }
    }

    fetchMemory()
    memoryTimerRef.current = setInterval(fetchMemory, 2000)

    return () => {
      if (memoryTimerRef.current) {
        clearInterval(memoryTimerRef.current)
      }
    }
  }, [])

  const handleOpenTab = useCallback(async () => {
    let url = urlInput.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url
    }
    await window.browserAPI.openTab(url)
  }, [urlInput])

  const handleCloseTab = useCallback(async (tabId: string) => {
    await window.browserAPI.closeTab(tabId)
  }, [])

  const handleCloseAll = useCallback(async () => {
    await window.browserAPI.closeAllTabs()
  }, [])

  const handleSwitchTab = useCallback(async (tabId: string) => {
    setActiveTabId(tabId)
    await window.browserAPI.switchTab(tabId)
  }, [])

  const handleAutoTestStart = useCallback(async () => {
    const urls = testUrls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0)
    if (urls.length === 0) return

    setAutoTestRunning(true)
    await window.browserAPI.autoTestStart({
      urls,
      openDelay: testOpenDelay,
      closeDelay: testCloseDelay,
      rounds: testRounds,
    })
  }, [testUrls, testOpenDelay, testCloseDelay, testRounds])

  const handleAutoTestStop = useCallback(async () => {
    await window.browserAPI.autoTestStop()
  }, [])

  const memoryTrend = memoryHistory.length >= 2
    ? memoryHistory[memoryHistory.length - 1].memory - memoryHistory[0].memory
    : 0

  return (
    <div className="browser-sim-toolbar">
      {lastProcessDiagnostic && (
        <div className="process-diagnostic-banner" title={lastProcessDiagnostic}>
          <span className="process-diagnostic-label">进程诊断</span>
          <span className="process-diagnostic-text">{lastProcessDiagnostic}</span>
          <button
            type="button"
            className="process-diagnostic-dismiss"
            onClick={() => setLastProcessDiagnostic(null)}
          >
            清除
          </button>
        </div>
      )}
      <div className="address-bar">
        <div className="address-bar-left">
          <span className="logo">🧪</span>
          <input
            className="url-input"
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleOpenTab()}
            placeholder="URL（与 launcher 标签页同 session / UA 策略）"
          />
          <button className="btn btn-primary" onClick={handleOpenTab}>
            打开
          </button>
          <button
            className="btn btn-danger"
            onClick={handleCloseAll}
            disabled={tabs.length === 0}
          >
            关闭全部 ({tabs.length})
          </button>
        </div>
        <div className="address-bar-right">
          {launchEnv && (
            <div
              className="memory-badge launch-env-badge"
              title="与本 demo 启动时的 GPU 相关环境变量一致；与 launcher 对照时请用相同变量启动"
            >
              <span className="label">GPU 规避</span>
              <span className="value">
                {launchEnv.disableHardwareAcceleration ? '无HW加速 ' : ''}
                {launchEnv.disableGpuSandboxSwitch ? '无GPU沙箱' : '默认'}
              </span>
            </div>
          )}
          <div className="memory-badge">
            <span className="label">进程</span>
            <span className="value">{memoryInfo?.processCount || 0}</span>
          </div>
          <div className="memory-badge">
            <span className="label">总内存</span>
            <span className="value">
              {memoryInfo ? formatBytes(memoryInfo.totalMemory * 1024) : '—'}
            </span>
          </div>
          <div className={`memory-badge ${memoryTrend > 0 ? 'trend-up' : memoryTrend < 0 ? 'trend-down' : ''}`}>
            <span className="label">趋势</span>
            <span className="value">
              {memoryTrend > 0 ? '↑' : memoryTrend < 0 ? '↓' : '—'}
              {memoryTrend !== 0 ? formatBytes(Math.abs(memoryTrend) * 1024) : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="bottom-section">
        <div className="tab-bar">
          {tabs.length === 0 ? (
            <span className="no-tabs">暂无标签页 — 对齐 launcher：非当前标签 bounds 为 0×0，切换会 reload</span>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab-item ${activeTabId === tab.id ? 'active' : ''}`}
                onClick={() => handleSwitchTab(tab.id)}
              >
                <span className="tab-title">{tab.title || tab.url}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCloseTab(tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <div className="auto-test-panel">
          {autoTestRunning ? (
            <div className="auto-test-running">
              <span className="spinner">⏳</span>
              <span>
                第 {autoTestProgress?.round || 0}/{autoTestProgress?.totalRounds || 0} 轮
                {' '}
                — {autoTestProgress?.phase === 'opening' ? '🔵 打开中' : '🔴 关闭中'}
              </span>
              <button className="btn btn-danger btn-sm" onClick={handleAutoTestStop}>
                停止
              </button>
            </div>
          ) : (
            <div className="auto-test-config">
              <label>
                轮次
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={testRounds}
                  onChange={(e) => setTestRounds(Number(e.target.value))}
                />
              </label>
              <label>
                打开间隔(ms)
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={testOpenDelay}
                  onChange={(e) => setTestOpenDelay(Number(e.target.value))}
                />
              </label>
              <label>
                关闭间隔(ms)
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={testCloseDelay}
                  onChange={(e) => setTestCloseDelay(Number(e.target.value))}
                />
              </label>
              <button className="btn btn-primary btn-sm" onClick={handleAutoTestStart}>
                ▶ 启动自动测试
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
