import { useState, useEffect } from 'react'
import type { AppInfo } from './types/electron'
import './styles/app.less'

function App() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [count, setCount] = useState(0)

  useEffect(() => {
    // 通过 preload 暴露的 API 获取应用信息
    window.electronAPI?.getAppInfo().then((info) => {
      setAppInfo(info)
    })
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo-container">
          <div className="logo electron-logo">⚡</div>
          <div className="logo react-logo">⚛️</div>
        </div>
        <h1>Electron + React + TypeScript</h1>
        <p className="subtitle">Powered by Vite & Less</p>
      </header>

      <main className="app-main">
        <section className="card">
          <h2>计数器示例</h2>
          <div className="counter">
            <button onClick={() => setCount((c) => c - 1)}>−</button>
            <span className="count">{count}</span>
            <button onClick={() => setCount((c) => c + 1)}>+</button>
          </div>
        </section>

        {appInfo && (
          <section className="card info-card">
            <h2>应用信息</h2>
            <div className="info-grid">
              <div className="info-item">
                <span className="label">应用名称</span>
                <span className="value">{appInfo.name}</span>
              </div>
              <div className="info-item">
                <span className="label">应用版本</span>
                <span className="value">{appInfo.version}</span>
              </div>
              <div className="info-item">
                <span className="label">Electron</span>
                <span className="value">v{appInfo.electronVersion}</span>
              </div>
              <div className="info-item">
                <span className="label">Chrome</span>
                <span className="value">v{appInfo.chromeVersion}</span>
              </div>
              <div className="info-item">
                <span className="label">Node.js</span>
                <span className="value">v{appInfo.nodeVersion}</span>
              </div>
              <div className="info-item">
                <span className="label">平台</span>
                <span className="value">{appInfo.platform}</span>
              </div>
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>🚀 开始编辑 <code>src/App.tsx</code> 进行开发</p>
      </footer>
    </div>
  )
}

export default App
