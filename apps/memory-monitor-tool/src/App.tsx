import React, { useState, useEffect, useCallback } from 'react'
import DashboardPage from './pages/DashboardPage'
import ReportPage from './pages/ReportPage'
import ComparePage from './pages/ComparePage'
import { useMemoryData } from './hooks/useMemoryData'
import type { PageType } from './types'

const App: React.FC = () => {
  const [currentPage, setCurrentPage] = useState<PageType>('dashboard')
  const memoryData = useMemoryData()

  return (
    <div className="mmt-app">
      <nav className="mmt-nav">
        <div className="mmt-nav-brand">
          <span className="mmt-nav-icon">🔬</span>
          <span className="mmt-nav-title">Memory Monitor Tool</span>
        </div>
        <div className="mmt-nav-tabs">
          <button
            className={`mmt-nav-tab ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            📊 实时监控
          </button>
          <button
            className={`mmt-nav-tab ${currentPage === 'report' ? 'active' : ''}`}
            onClick={() => setCurrentPage('report')}
          >
            📋 测试报告
          </button>
          <button
            className={`mmt-nav-tab ${currentPage === 'compare' ? 'active' : ''}`}
            onClick={() => setCurrentPage('compare')}
          >
            ⚖️ 回归对比
          </button>
        </div>
      </nav>

      <main className="mmt-main">
        {currentPage === 'dashboard' && (
          <DashboardPage memoryData={memoryData} />
        )}
        {currentPage === 'report' && <ReportPage />}
        {currentPage === 'compare' && <ComparePage />}
      </main>
    </div>
  )
}

export default App
