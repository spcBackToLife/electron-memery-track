import React from 'react'
import MetricCard from '../components/MetricCard'
import ProcessTable from '../components/ProcessTable'
import MemoryChart from '../components/MemoryChart'
import MemoryPieChart from '../components/MemoryPieChart'
import AlertPanel from '../components/AlertPanel'
import SessionControl from '../components/SessionControl'
import V8HeapDetail from '../components/V8HeapDetail'
import { useMemoryData } from '../hooks/useMemoryData'
import { useSession } from '../hooks/useSession'

const formatKB = (kb: number | undefined | null): string => {
  if (kb == null || isNaN(kb)) return '0 KB'
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes === 0) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const Dashboard: React.FC = () => {
  const {
    snapshots,
    latestSnapshot,
    anomalies,
    isCollecting,
    triggerGC,
    addMark,
    clearAnomalies,
  } = useMemoryData()

  const {
    currentSessionId,
    isRunning,
    startSession,
    stopSession,
  } = useSession()

  if (!latestSnapshot) {
    return (
      <div className="dashboard-loading">
        <div className="loading-spinner"></div>
        <p>等待内存数据...</p>
      </div>
    )
  }

  const browserProcess = latestSnapshot.processes.find((p) => p.type === 'Browser')
  const rendererProcesses = latestSnapshot.processes.filter((p) => p.type === 'Tab' && !p.isMonitorProcess)
  const rendererTotalKB = rendererProcesses.reduce((sum, p) => sum + p.memory.workingSetSize, 0)

  return (
    <div className="dashboard">
      {/* 控制面板 */}
      <SessionControl
        isRunning={isRunning}
        currentSessionId={currentSessionId}
        onStart={startSession}
        onStop={stopSession}
        onTriggerGC={triggerGC}
        onAddMark={addMark}
      />

      {/* 顶部指标卡片 */}
      <div className="metric-cards-row">
        <MetricCard
          icon="💻"
          title="总内存"
          value={formatKB(latestSnapshot.totalWorkingSetSize)}
          color="#646cff"
        />
        <MetricCard
          icon="🧠"
          title="主进程"
          value={formatKB(browserProcess?.memory.workingSetSize || 0)}
          color="#f5a623"
        />
        <MetricCard
          icon="🖼️"
          title="渲染进程"
          value={formatKB(rendererTotalKB)}
          unit={`(${rendererProcesses.length}个)`}
          color="#61dafb"
        />
        <MetricCard
          icon="📊"
          title="V8 Heap Used"
          value={formatBytes(latestSnapshot.mainProcessMemory.heapUsed)}
          color="#52c41a"
        />
        <MetricCard
          icon="⚙️"
          title="系统内存"
          value={`${latestSnapshot.system.usagePercent}%`}
          color="#ff6b6b"
        />
        <MetricCard
          icon="🔢"
          title="进程数"
          value={`${latestSnapshot.processes.length}`}
          color="#8b8b8b"
        />
      </div>

      {/* 图表行 */}
      <div className="charts-row">
        <div className="chart-container chart-wide">
          <h3>📈 内存趋势</h3>
          <MemoryChart snapshots={snapshots} height={300} />
        </div>
        <div className="chart-container chart-narrow">
          <h3>🥧 内存分布</h3>
          <MemoryPieChart processes={latestSnapshot.processes} height={300} />
        </div>
      </div>

      {/* 进程表格 */}
      <div className="section">
        <h3>📋 进程详情</h3>
        <ProcessTable processes={latestSnapshot.processes} />
      </div>

      {/* V8 堆详情 */}
      {latestSnapshot.mainProcessV8Detail && (
        <div className="section">
          <V8HeapDetail v8Detail={latestSnapshot.mainProcessV8Detail} />
        </div>
      )}

      {/* 告警面板 */}
      <div className="section">
        <h3>🚨 异常告警</h3>
        <AlertPanel anomalies={anomalies} onClear={clearAnomalies} />
      </div>
    </div>
  )
}

export default Dashboard
