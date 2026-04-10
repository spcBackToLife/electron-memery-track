import React, { useState } from 'react'
import Dashboard from './pages/Dashboard'
import Report from './pages/Report'
import Compare from './pages/Compare'

type Page = 'dashboard' | 'report' | 'compare'

const MonitorApp: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')

  return (
    <div className="monitor-app">
      <nav className="monitor-nav">
        <div className="monitor-nav-brand">
          <span className="monitor-nav-icon">📊</span>
          <span className="monitor-nav-title">Electron Memory Monitor</span>
        </div>
        <div className="monitor-nav-tabs">
          <button
            className={`monitor-nav-tab ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            🔴 实时监控
          </button>
          <button
            className={`monitor-nav-tab ${currentPage === 'report' ? 'active' : ''}`}
            onClick={() => setCurrentPage('report')}
          >
            📋 历史报告
          </button>
          <button
            className={`monitor-nav-tab ${currentPage === 'compare' ? 'active' : ''}`}
            onClick={() => setCurrentPage('compare')}
          >
            🔄 迭代对比
          </button>
        </div>
      </nav>

      <main className="monitor-main">
        {/*
          仅挂载当前页：若三页同时 display:none 切换，Report/Compare 内 fixed、100vh、图表层
          在部分 Electron/Chromium 下仍可能挡住命中测试，导致实时监控里「结束会话」点不动。
          切换 Tab 会卸载非当前页（报告列表滚动位置会重置；进入页时会 refreshSessions）。
        */}
        {currentPage === 'dashboard' && <Dashboard paneVisible />}
        {currentPage === 'report' && <Report paneVisible />}
        {currentPage === 'compare' && <Compare paneVisible />}
      </main>
    </div>
  )
}

export default MonitorApp
