import React, { useEffect, useState, useMemo, useCallback } from 'react'
import SuggestionPanel from '../components/SuggestionPanel'
import MemoryChart from '../components/MemoryChart'
import MemoryPieChart from '../components/MemoryPieChart'
import ProcessTable from '../components/ProcessTable'
import V8HeapDetail from '../components/V8HeapDetail'
import { useSession } from '../hooks/useSession'
import type { TestSession } from '../../types/session'
import type { SessionReport } from '../../types/report'
import type { MemorySnapshot } from '../../types/snapshot'

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes === 0) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const formatKB = (kb: number | undefined | null): string => {
  if (kb == null || isNaN(kb)) return '0 KB'
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

const formatTimeHM = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

/** 时间范围预设选项 */
const TIME_PRESETS = [
  { label: '全部', value: 'all' },
  { label: '最近 1 分钟', value: '1m' },
  { label: '最近 5 分钟', value: '5m' },
  { label: '最近 10 分钟', value: '10m' },
  { label: '最近 30 分钟', value: '30m' },
  { label: '自定义', value: 'custom' },
] as const

/** 显示粒度选项 */
const GRANULARITY_OPTIONS = [
  { label: '自动', value: 0 },
  { label: '最多 200 点', value: 200 },
  { label: '最多 400 点', value: 400 },
  { label: '最多 600 点', value: 600 },
  { label: '最多 1000 点', value: 1000 },
] as const

const Report: React.FC = () => {
  const { sessions, refreshSessions, getSessionReport, getSessionSnapshots, exportSession, importSession, deleteSession } = useSession()
  const [selectedSession, setSelectedSession] = useState<TestSession | null>(null)
  const [report, setReport] = useState<SessionReport | null>(null)
  const [snapshots, setSnapshots] = useState<MemorySnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [snapshotsLoading, setSnapshotsLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)

  // 时间范围控制
  const [timePreset, setTimePreset] = useState<string>('all')
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')
  const [maxPoints, setMaxPoints] = useState<number>(0) // 0 = 自动

  // 可视化面板展开控制
  const [showChart, setShowChart] = useState(true)
  const [showPie, setShowPie] = useState(true)
  const [showProcesses, setShowProcesses] = useState(true)
  const [showV8, setShowV8] = useState(true)

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  const handleSelectSession = async (session: TestSession) => {
    setSelectedSession(session)
    setLoading(true)
    setTimePreset('all')
    try {
      const r = await getSessionReport(session.id)
      setReport(r)
    } catch (err) {
      console.error('Failed to load report:', err)
    }
    setLoading(false)
  }

  // 计算实际的时间范围
  const timeRange = useMemo(() => {
    if (!report) return { start: undefined as number | undefined, end: undefined as number | undefined }

    const sessionEnd = report.endTime
    switch (timePreset) {
      case '1m': return { start: sessionEnd - 60 * 1000, end: sessionEnd }
      case '5m': return { start: sessionEnd - 5 * 60 * 1000, end: sessionEnd }
      case '10m': return { start: sessionEnd - 10 * 60 * 1000, end: sessionEnd }
      case '30m': return { start: sessionEnd - 30 * 60 * 1000, end: sessionEnd }
      case 'custom': {
        const s = customStart ? new Date(customStart).getTime() : undefined
        const e = customEnd ? new Date(customEnd).getTime() : undefined
        return { start: s && !isNaN(s) ? s : undefined, end: e && !isNaN(e) ? e : undefined }
      }
      default: return { start: undefined, end: undefined }
    }
  }, [report, timePreset, customStart, customEnd])

  // 自动计算最大点数
  const effectiveMaxPoints = useMemo(() => {
    if (maxPoints > 0) return maxPoints
    // 自动：如果会话超过10分钟用400点，超过30分钟用300点，否则600点
    if (!report) return 600
    const durationMin = report.duration / 60000
    if (durationMin > 30) return 300
    if (durationMin > 10) return 400
    return 600
  }, [maxPoints, report])

  // 加载快照数据
  const loadSnapshots = useCallback(async () => {
    if (!selectedSession) return
    setSnapshotsLoading(true)
    try {
      const data = await getSessionSnapshots(
        selectedSession.id,
        timeRange.start,
        timeRange.end,
        effectiveMaxPoints
      )
      setSnapshots(data)
    } catch (err) {
      console.error('Failed to load snapshots:', err)
    }
    setSnapshotsLoading(false)
  }, [selectedSession, getSessionSnapshots, timeRange.start, timeRange.end, effectiveMaxPoints])

  // 当会话或时间范围变化时自动加载快照
  useEffect(() => {
    if (selectedSession && report) {
      loadSnapshots()
    }
  }, [selectedSession, report, loadSnapshots])

  // 导出会话
  const handleExportSession = async (sessionId: string) => {
    setExporting(true)
    try {
      const result = await exportSession(sessionId)
      if (result?.success) {
        console.log('导出成功:', result.filePath)
      } else if (result?.error && result.error !== '用户取消') {
        console.error('导出失败:', result.error)
        alert('导出失败: ' + result.error)
      }
    } catch (err) {
      console.error('导出异常:', err)
    }
    setExporting(false)
  }

  // 导入会话
  const handleImportSession = async () => {
    setImporting(true)
    try {
      const result = await importSession()
      if (result?.success) {
        console.log('导入成功')
      } else if (result?.error && result.error !== '用户取消') {
        console.error('导入失败:', result.error)
        alert('导入失败: ' + result.error)
      }
    } catch (err) {
      console.error('导入异常:', err)
    }
    setImporting(false)
  }

  // 删除会话
  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    if (!confirm('确定要删除这个会话吗？此操作不可恢复。')) return
    const ok = await deleteSession(sessionId)
    if (ok && selectedSession?.id === sessionId) {
      setSelectedSession(null)
      setReport(null)
      setSnapshots([])
    }
  }

  // 最后一条快照（用于饼图和进程表格）
  const latestSnapshot = useMemo(() => {
    return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  }, [snapshots])

  // 中间点快照（用于更具代表性的饼图）
  const midSnapshot = useMemo(() => {
    if (snapshots.length === 0) return null
    return snapshots[Math.floor(snapshots.length / 2)]
  }, [snapshots])

  return (
    <div className="report-page">
      <div className="report-layout">
        {/* 左侧：会话列表 */}
        <div className="session-list">
          <h3>📋 历史会话</h3>
          <div className="session-list-actions">
            <button className="btn btn-secondary btn-sm" onClick={refreshSessions}>
              🔄 刷新
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleImportSession}
              disabled={importing}
            >
              {importing ? '⏳ 导入中...' : '📥 导入'}
            </button>
          </div>

          {sessions.length === 0 ? (
            <div className="session-list-empty">
              <p>暂无历史会话</p>
              <p className="hint">在实时监控页面开始一个测试会话</p>
            </div>
          ) : (
            <div className="session-items">
              {[...sessions].reverse().map((session) => (
                <div
                  key={session.id}
                  className={`session-item ${selectedSession?.id === session.id ? 'active' : ''}`}
                  onClick={() => handleSelectSession(session)}
                >
                  <div className="session-item-header">
                    <div className="session-item-label">{session.label}</div>
                    <div className="session-item-actions">
                      <button
                        className="btn-icon"
                        title="导出会话"
                        onClick={(e) => { e.stopPropagation(); handleExportSession(session.id) }}
                        disabled={exporting}
                      >
                        📤
                      </button>
                      <button
                        className="btn-icon btn-icon-danger"
                        title="删除会话"
                        onClick={(e) => handleDeleteSession(e, session.id)}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <div className="session-item-meta">
                    <span>{new Date(session.startTime).toLocaleDateString()}</span>
                    <span>{session.duration ? formatDuration(session.duration) : '进行中'}</span>
                    <span>{session.snapshotCount} 条</span>
                  </div>
                  <span className={`session-status ${session.status}`}>{session.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右侧：报告详情 */}
        <div className="report-detail">
          {loading && <div className="report-loading">加载中...</div>}

          {!loading && !report && (
            <div className="report-placeholder">
              <span className="report-placeholder-icon">📊</span>
              <p>选择左侧的会话查看报告</p>
            </div>
          )}

          {!loading && report && (
            <div className="report-content">
              <h2>{report.label}</h2>
              {report.description && <p className="report-desc">{report.description}</p>}
              <div className="report-meta-bar">
                <span>⏱️ {formatDuration(report.duration)}</span>
                <span>📅 {new Date(report.startTime).toLocaleString()} ~ {new Date(report.endTime).toLocaleString()}</span>
              </div>

              {/* 环境信息 */}
              <div className="report-section">
                <h3>🖥️ 运行环境</h3>
                <div className="env-grid">
                  <div className="env-item">
                    <span className="env-label">Electron</span>
                    <span className="env-value">v{report.environment.electronVersion}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-label">Chrome</span>
                    <span className="env-value">v{report.environment.chromeVersion}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-label">Node.js</span>
                    <span className="env-value">v{report.environment.nodeVersion}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-label">平台</span>
                    <span className="env-value">{report.environment.platform}/{report.environment.arch}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-label">系统内存</span>
                    <span className="env-value">{formatBytes(report.environment.totalSystemMemory)}</span>
                  </div>
                  <div className="env-item">
                    <span className="env-label">CPU</span>
                    <span className="env-value">{report.environment.cpuCores} 核</span>
                  </div>
                </div>
              </div>

              {/* 统计汇总 */}
              <div className="report-section">
                <h3>📊 统计汇总</h3>
                <table className="report-stats-table">
                  <thead>
                    <tr>
                      <th>指标</th>
                      <th>初始值</th>
                      <th>最终值</th>
                      <th>平均值</th>
                      <th>P95</th>
                      <th>变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>总内存</td>
                      <td>{formatKB(report.summary.totalMemory.initial)}</td>
                      <td>{formatKB(report.summary.totalMemory.final)}</td>
                      <td>{formatKB(report.summary.totalMemory.avg)}</td>
                      <td>{formatKB(report.summary.totalMemory.p95)}</td>
                      <td className={report.summary.totalMemory.deltaPercent > 5 ? 'degraded' : ''}>
                        {report.summary.totalMemory.deltaPercent > 0 ? '+' : ''}{report.summary.totalMemory.deltaPercent.toFixed(1)}%
                      </td>
                    </tr>
                    <tr>
                      <td>主进程</td>
                      <td>{formatKB(report.summary.byProcessType.browser.initial)}</td>
                      <td>{formatKB(report.summary.byProcessType.browser.final)}</td>
                      <td>{formatKB(report.summary.byProcessType.browser.avg)}</td>
                      <td>{formatKB(report.summary.byProcessType.browser.p95)}</td>
                      <td className={report.summary.byProcessType.browser.deltaPercent > 10 ? 'degraded' : ''}>
                        {report.summary.byProcessType.browser.deltaPercent > 0 ? '+' : ''}{report.summary.byProcessType.browser.deltaPercent.toFixed(1)}%
                      </td>
                    </tr>
                    <tr>
                      <td>V8 Heap Used</td>
                      <td>{formatBytes(report.summary.mainV8Heap.heapUsed.initial)}</td>
                      <td>{formatBytes(report.summary.mainV8Heap.heapUsed.final)}</td>
                      <td>{formatBytes(report.summary.mainV8Heap.heapUsed.avg)}</td>
                      <td>{formatBytes(report.summary.mainV8Heap.heapUsed.p95)}</td>
                      <td className={report.summary.mainV8Heap.heapUsed.deltaPercent > 10 ? 'degraded' : ''}>
                        {report.summary.mainV8Heap.heapUsed.deltaPercent > 0 ? '+' : ''}{report.summary.mainV8Heap.heapUsed.deltaPercent.toFixed(1)}%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ========== 可视化面板：时间控制 + 图表 ========== */}
              <div className="report-section report-visual-section">
                <h3>📈 数据可视化</h3>

                {/* 时间范围和粒度控制 */}
                <div className="report-time-controls">
                  <div className="time-presets">
                    <span className="control-label">时间范围：</span>
                    {TIME_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        className={`btn btn-sm ${timePreset === preset.value ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setTimePreset(preset.value)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  {timePreset === 'custom' && (
                    <div className="time-custom-range">
                      <span className="control-label">自定义范围：</span>
                      <input
                        type="text"
                        placeholder={`起始 (如 ${formatTimeHM(report.startTime)})`}
                        value={customStart}
                        onChange={(e) => setCustomStart(e.target.value)}
                      />
                      <span>~</span>
                      <input
                        type="text"
                        placeholder={`结束 (如 ${formatTimeHM(report.endTime)})`}
                        value={customEnd}
                        onChange={(e) => setCustomEnd(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="granularity-control">
                    <span className="control-label">显示粒度：</span>
                    <select
                      value={maxPoints}
                      onChange={(e) => setMaxPoints(Number(e.target.value))}
                    >
                      {GRANULARITY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <span className="data-info">
                      {snapshotsLoading ? '加载中...' : `已加载 ${snapshots.length} 个数据点`}
                    </span>
                  </div>
                </div>

                {/* 折叠面板标题栏 */}
                <div className="report-panel-toggles">
                  <button className={`panel-toggle ${showChart ? 'active' : ''}`} onClick={() => setShowChart(!showChart)}>
                    📈 内存趋势
                  </button>
                  <button className={`panel-toggle ${showPie ? 'active' : ''}`} onClick={() => setShowPie(!showPie)}>
                    🥧 内存分布
                  </button>
                  <button className={`panel-toggle ${showProcesses ? 'active' : ''}`} onClick={() => setShowProcesses(!showProcesses)}>
                    📋 进程详情
                  </button>
                  <button className={`panel-toggle ${showV8 ? 'active' : ''}`} onClick={() => setShowV8(!showV8)}>
                    🔧 V8 堆详情
                  </button>
                </div>

                {snapshotsLoading && (
                  <div className="report-snapshots-loading">
                    <div className="loading-spinner" style={{ width: 24, height: 24 }}></div>
                    <span>正在加载快照数据...</span>
                  </div>
                )}

                {!snapshotsLoading && snapshots.length === 0 && (
                  <div className="report-no-data">
                    <span>该时间范围内无数据</span>
                  </div>
                )}

                {!snapshotsLoading && snapshots.length > 0 && (
                  <>
                    {/* 内存趋势图 */}
                    {showChart && (
                      <div className="report-chart-panel">
                        <div className="chart-container" style={{ margin: 0 }}>
                          <h4>📈 内存趋势（{formatTimeHM(snapshots[0].timestamp)} ~ {formatTimeHM(snapshots[snapshots.length - 1].timestamp)}）</h4>
                          <MemoryChart snapshots={snapshots} height={320} />
                        </div>
                      </div>
                    )}

                    {/* 内存分布饼图 + 进程详情 并排 */}
                    {(showPie || showProcesses) && (
                      <div className="report-charts-row">
                        {showPie && midSnapshot && (
                          <div className="chart-container" style={{ margin: 0, flex: showProcesses ? '0 0 360px' : '1' }}>
                            <h4>🥧 内存分布（中间时刻快照）</h4>
                            <MemoryPieChart processes={midSnapshot.processes} height={280} />
                          </div>
                        )}
                        {showProcesses && latestSnapshot && (
                          <div className="chart-container" style={{ margin: 0, flex: 1, overflow: 'auto' }}>
                            <h4>📋 进程详情（最后时刻快照）</h4>
                            <ProcessTable processes={latestSnapshot.processes} />
                          </div>
                        )}
                      </div>
                    )}

                    {/* V8 堆详情 */}
                    {showV8 && latestSnapshot?.mainProcessV8Detail && (
                      <div className="report-chart-panel">
                        <div className="chart-container" style={{ margin: 0 }}>
                          <V8HeapDetail v8Detail={latestSnapshot.mainProcessV8Detail} />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 趋势分析 */}
              <div className="report-section">
                <h3>📈 趋势分析</h3>
                <div className="trend-grid">
                  {(['totalMemory', 'browserMemory', 'rendererMemory'] as const).map((key) => {
                    const trend = report.summary.trends[key]
                    const directionIcon = trend.direction === 'growing' ? '📈' : trend.direction === 'shrinking' ? '📉' : '→'
                    const directionLabel = trend.direction === 'growing' ? '增长' : trend.direction === 'shrinking' ? '下降' : '稳定'
                    const label = key === 'totalMemory' ? '总内存' : key === 'browserMemory' ? '主进程' : '渲染进程'
                    return (
                      <div key={key} className="trend-item">
                        <span className="trend-label">{label}</span>
                        <span className="trend-direction">{directionIcon} {directionLabel}</span>
                        <span className="trend-slope">{trend.slope.toFixed(2)} KB/s</span>
                        <span className="trend-r2">R²={trend.r2.toFixed(3)}</span>
                        <span className={`trend-confidence ${trend.confidence}`}>{trend.confidence}</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 改进建议 */}
              <div className="report-section">
                <h3>💡 改进建议</h3>
                <SuggestionPanel suggestions={report.suggestions} />
              </div>

              {/* 异常事件 */}
              {report.anomalies.length > 0 && (
                <div className="report-section">
                  <h3>🚨 异常事件 ({report.anomalies.length})</h3>
                  <div className="anomaly-timeline">
                    {report.anomalies.map((a) => (
                      <div key={a.id} className={`anomaly-item severity-${a.severity}`}>
                        <span className="anomaly-time">{new Date(a.timestamp).toLocaleTimeString()}</span>
                        <span className="anomaly-title">{a.title}</span>
                        <span className="anomaly-desc">{a.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Report
