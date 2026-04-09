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
        {/* 各页均保持挂载，仅用 display 切换，避免丢失会话状态、IPC 与列表滚动位置 */}
        <div style={{ display: currentPage === 'dashboard' ? 'block' : 'none' }}>
          <Dashboard paneVisible={currentPage === 'dashboard'} />
        </div>
        <div style={{ display: currentPage === 'report' ? 'block' : 'none' }}>
          <Report paneVisible={currentPage === 'report'} />
        </div>
        <div style={{ display: currentPage === 'compare' ? 'block' : 'none' }}>
          <Compare paneVisible={currentPage === 'compare'} />
        </div>
      </main>
    </div>
  )
}

export default MonitorApp
