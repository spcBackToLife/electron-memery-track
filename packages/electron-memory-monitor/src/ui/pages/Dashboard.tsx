import React, { useEffect, useCallback, useState } from 'react'
import MetricCard from '../components/MetricCard'
import ProcessTable from '../components/ProcessTable'
import MemoryChart from '../components/MemoryChart'
import MarkMemoryExplorer from '../components/MarkMemoryExplorer'
import MemoryPieChart from '../components/MemoryPieChart'
import AlertPanel from '../components/AlertPanel'
import SessionControl from '../components/SessionControl'
import V8HeapDetail from '../components/V8HeapDetail'
import RendererV8Table from '../components/RendererV8Table'
import { useSession } from '../hooks/useSession'
import type { MemoryData } from '../hooks/useMemoryData'
import type { AnomalyAction } from '../../types/anomaly'
import type { GCResult } from '../../types/report'
import { useToast } from '../context/ToastContext'
import { getEffectiveMemoryKB } from '../../core/utils'

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

const heapUsedToMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)

interface DashboardProps {
  paneVisible?: boolean
  /** 由 MonitorApp 提升到顶层的实时内存数据，避免 Tab 切换丢失 */
  memoryData: MemoryData
}

const Dashboard: React.FC<DashboardProps> = ({ paneVisible = true, memoryData }) => {
  const {
    snapshots,
    latestSnapshot,
    anomalies,
    triggerGC,
    addMark,
    clearAnomalies,
    markTimeline,
    takeHeapSnapshot,
  } = memoryData

  const {
    currentSessionId,
    isRunning,
    startSession,
    stopSession,
    refreshSessions,
  } = useSession()

  const { showToast } = useToast()
  const [gcPending, setGcPending] = useState(false)

  const handleTriggerGC = useCallback(async () => {
    setGcPending(true)
    try {
      const r: GCResult | undefined = await triggerGC()
      if (r == null) {
        showToast('GC 失败：未连接到监控（monitorAPI 不可用）', 'error')
        return
      }
      const mode = r.mode ?? 'none'
      const before = heapUsedToMb(r.beforeHeapUsed)
      const after = heapUsedToMb(r.afterHeapUsed)
      const freedMb = r.freed / 1024 / 1024

      if (mode === 'none') {
        showToast(
          `GC：未执行强制回收（未暴露 global.gc）。主进程堆采样约 ${before} → ${after} MB。图表多为子进程内存，可能几乎不变。请用启动参数 --js-flags="--expose-gc" 后再试。`,
          'info',
        )
      } else {
        const delta =
          freedMb >= 0
            ? `估算释放 ${freedMb.toFixed(2)} MB（约 ${r.freedPercent.toFixed(1)}%）`
            : `堆增加 ${Math.abs(freedMb).toFixed(2)} MB（GC 后仍可能有新分配）`
        showToast(
          `GC 已完成（主进程 V8）：${before} → ${after} MB，${delta}`,
          freedMb > 0.05 ? 'success' : 'info',
        )
      }
    } catch (e) {
      showToast(`GC 失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setGcPending(false)
    }
  }, [triggerGC, showToast])

  const handleTakeHeapSnapshot = useCallback(async () => {
    try {
      const filePath = await takeHeapSnapshot()
      if (filePath) {
        console.log('[EMM] Heap snapshot saved:', filePath)
      }
    } catch (err) {
      console.error('[EMM] Failed to take heap snapshot:', err)
    }
  }, [takeHeapSnapshot])

  const handleAnomalyAction = useCallback(
    (action: AnomalyAction) => {
      switch (action.type) {
        case 'heap-snapshot':
          handleTakeHeapSnapshot()
          break
        case 'trigger-gc':
          void handleTriggerGC()
          break
        case 'open-devtools':
          // 暂不实现，DevTools 需要另外的 IPC
          console.log('[EMM] open-devtools action not implemented yet')
          break
      }
    },
    [handleTakeHeapSnapshot, handleTriggerGC],
  )

  useEffect(() => {
    if (paneVisible) void refreshSessions()
  }, [paneVisible, refreshSessions])

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
  const rendererTotalKB = rendererProcesses.reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)

  return (
    <div className="dashboard">
      {/* 控制面板 */}
      <SessionControl
        isRunning={isRunning}
        currentSessionId={currentSessionId}
        onStart={startSession}
        onStop={stopSession}
        onTriggerGC={() => {
          void handleTriggerGC()
        }}
        gcPending={gcPending}
        onAddMark={addMark}
        onTakeHeapSnapshot={handleTakeHeapSnapshot}
        markCount={markTimeline.length}
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
          title="Browser 工作集"
          value={formatKB(browserProcess ? getEffectiveMemoryKB(browserProcess.memory) : 0)}
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
          title="主进程 V8 Used"
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
          <p className="chart-marks-caption">
            代码里 <code>monitor.mark()</code> 或手动「标记」会在<strong>下一拍采样</strong>写入；趋势图横轴为时间戳，橙色竖线为各 Mark 时刻。
          </p>
          <MemoryChart snapshots={snapshots} height={300} />
        </div>
        <div className="chart-container chart-narrow">
          <h3>🥧 内存分布</h3>
          <MemoryPieChart processes={latestSnapshot.processes} height={300} />
        </div>
      </div>

      <div className="section dashboard-mark-explorer-section">
        <h3>📍 标记点内存对比与详情</h3>
        <p className="report-marks-hint" style={{ marginTop: 0 }}>
          下图汇总当前缓冲区内各标记所在采样时刻；下拉或点击柱形查看该时刻的进程表、主进程 V8 与各渲染进程 V8 表。完整会话请结束后在「历史报告」查看。
        </p>
        <MarkMemoryExplorer snapshots={snapshots} variant="dashboard" />
      </div>

      {/* 进程表格 */}
      <div className="section">
        <h3>📋 进程详情</h3>
        <p className="process-table-caption">
          由系统枚举<strong>全部</strong> Electron 子进程（含每个 Tab），与当前焦点标签无关，无需为了看内存去切换 Tab。
        </p>
        <ProcessTable processes={latestSnapshot.processes} />
      </div>

      {/* 主进程 V8（Node）与渲染进程 V8（Chromium，多行） */}
      {latestSnapshot.mainProcessV8Detail && (
        <div className="section">
          <V8HeapDetail v8Detail={latestSnapshot.mainProcessV8Detail} />
        </div>
      )}
      <div className="section">
        <RendererV8Table
          processes={latestSnapshot.processes}
          details={latestSnapshot.rendererDetails}
        />
      </div>

      {/* 告警面板 */}
      <div className="section">
        <h3>🚨 异常告警</h3>
        <AlertPanel anomalies={anomalies} onClear={clearAnomalies} onAction={handleAnomalyAction} />
      </div>
    </div>
  )
}

export default Dashboard
