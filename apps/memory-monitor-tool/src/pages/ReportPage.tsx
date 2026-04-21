import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type { MemorySnapshot, ReportEventMark, TestSession, ReportSummary } from '../types'
import { formatDuration, formatTime } from '../utils/format'
import { collectReportEventMarksFromSnapshots } from '../utils/reportEventMarks'
import { useToast } from '../context/ToastContext'
import ReportDataCharts from '../components/ReportDataCharts'
import { computeResourceSummaryFromDataPoints } from '../utils/reportResourceSummary'

/**
 * 报告页面 - 面向测试的解读型报告
 * 不展示技术细节，给出 PASS/WARN/FAIL 结论
 */
const ReportPage: React.FC = () => {
  const [sessions, setSessions] = useState<TestSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [report, setReport] = useState<ReportSummary | null>(null)
  const [loading, setLoading] = useState(false)
  /** 旧版 report.json 无 eventMarks 时，从快照推导 */
  const [marksFallback, setMarksFallback] = useState<ReportEventMark[]>([])
  const { showToast } = useToast()

  const loadSessions = useCallback(async () => {
    try {
      const list = await window.monitorAPI.listSessions() as TestSession[]
      setSessions(list.filter((s) => s.status === 'completed'))

      // 自动选中第一个
      if (!selectedId && list.length > 0) {
        const firstCompleted = list.find((s) => s.status === 'completed')
        if (firstCompleted) setSelectedId(firstCompleted.id)
      }
    } catch (err) {
      console.error('[ReportPage] Failed to load sessions:', err)
    }
  }, [selectedId])

  const loadReport = useCallback(async (sessionId: string) => {
    setLoading(true)
    try {
      const r = await window.monitorAPI.getSessionReport(sessionId) as ReportSummary | null
      setReport(r)
    } catch (err) {
      console.error('[ReportPage] Failed to load report:', err)
      showToast('加载报告失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (selectedId) {
      loadReport(selectedId)
    }
  }, [selectedId, loadReport])

  useEffect(() => {
    setMarksFallback([])
    if (!selectedId || !report) return
    /** 新版 report.json 总带 eventMarks 字段；仅旧文件缺字段时才从快照推导 */
    if (report.eventMarks !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const snaps = (await window.monitorAPI.getSessionSnapshots(selectedId, 2000)) as MemorySnapshot[]
        if (cancelled) return
        setMarksFallback(collectReportEventMarksFromSnapshots(snaps))
      } catch {
        if (!cancelled) setMarksFallback([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, report])

  const handleDelete = async (sessionId: string) => {
    try {
      const success = await window.monitorAPI.deleteSession(sessionId)
      if (success) {
        showToast('已删除', 'success')
        if (selectedId === sessionId) {
          setSelectedId(null)
          setReport(null)
        }
        loadSessions()
      }
    } catch (err) {
      showToast(`删除失败: ${err}`, 'error')
    }
  }

  const handleExport = async (sessionId: string) => {
    try {
      const result = await window.monitorAPI.exportSession(sessionId)
      if (result.success) {
        showToast(`已导出至 ${result.filePath}`, 'success')
      } else {
        showToast(result.error || '导出失败', 'error')
      }
    } catch (err) {
      showToast(`导出失败: ${err}`, 'error')
    }
  }

  const marksForTable =
    report != null && report.eventMarks !== undefined ? report.eventMarks : marksFallback

  const resourceSummaryResolved = useMemo(() => {
    if (!report) return null
    if (report.resourceSummary) return report.resourceSummary
    return computeResourceSummaryFromDataPoints(report.dataPoints) ?? null
  }, [report])

  const conclusionConfig: Record<string, { label: string; color: string; icon: string }> = {
    PASS: { label: '通过', color: '#52c41a', icon: '✅' },
    WARN: { label: '警告', color: '#faad14', icon: '⚠️' },
    FAIL: { label: '失败', color: '#ff4d4f', icon: '❌' },
  }

  return (
    <div className="mmt-report-page">
      <div className="report-layout">
        {/* 左侧：会话列表 */}
        <aside className="report-sidebar">
          <h3>📋 历史报告 ({sessions.length})</h3>
          <div className="session-list">
            {sessions.map((sess) => (
              <div
                key={sess.id}
                className={`session-item ${selectedId === sess.id ? 'active' : ''}`}
                onClick={() => setSelectedId(sess.id)}
              >
                <span className="session-label">{sess.label}</span>
                <span className="session-time">
                  {new Date(sess.startTime).toLocaleString()} · {formatDuration(sess.endTime! - sess.startTime)} · {sess.snapshotCount} 拍
                </span>
                <div className="session-actions">
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={(e) => { e.stopPropagation(); void handleExport(sess.id) }}
                    title="导出"
                  >📤</button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(sess.id) }}
                    title="删除"
                  >🗑️</button>
                </div>
              </div>
            ))}
            {sessions.length === 0 && (
              <div className="session-empty">暂无已完成会话。请在实时监控页结束一个会话。</div>
            )}
          </div>
        </aside>

        {/* 右侧：报告详情 */}
        <main className="report-detail">
          {loading ? (
            <div className="mmt-loading"><div className="loading-spinner"></div><p>加载中...</p></div>
          ) : report ? (
            <>
              {/* 报告头 */}
              <div className="report-header">
                <h2>{report.label}</h2>
                {report.description && <p>{report.description}</p>}
                <div className="report-meta">
                  <span>🕐 {new Date(report.startTime).toLocaleString()} — {new Date(report.endTime).toLocaleString()}</span>
                  <span>⏱️ 时长 {formatDuration(report.durationMs)}</span>
                  <span>📸 {report.snapshotCount} 个采样点</span>
                </div>
              </div>

              {/* 核心结论 */}
              <div className="report-conclusion">
                <h3>🏁 测试结论</h3>
                <div className={`conclusion-badge ${report.trendAnalysis.conclusion.toLowerCase()}`}
                  style={{ borderColor: conclusionConfig[report.trendAnalysis.conclusion].color }}
                >
                  <span className="conclusion-icon">{conclusionConfig[report.trendAnalysis.conclusion].icon}</span>
                  <span className="conclusion-label">{conclusionConfig[report.trendAnalysis.conclusion].label}</span>
                </div>
                <p className="conclusion-reason">{report.trendAnalysis.reason}</p>
              </div>

              <ReportDataCharts report={report} eventMarks={marksForTable.length > 0 ? marksForTable : undefined} />

              {marksForTable.length > 0 && (
                <div className="report-event-marks">
                  <h3>📍 阶段标记（Mark）</h3>
                  <p className="chart-caption">
                    与实时监控「📌 标记」一致：写入<strong>下一拍采样</strong>。表中为标记时刻各分类内存（KB→MB），便于对照趋势图竖线。
                  </p>
                  <div className="report-marks-table-wrap">
                    <table className="data-table report-marks-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>时间</th>
                          <th>标签</th>
                          <th>总内存 (MB)</th>
                          <th>主进程 (MB)</th>
                          <th>渲染/子进程 (MB)</th>
                          <th>GPU (MB)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {marksForTable.map((m, i) => (
                          <tr key={`${m.timestamp}-${m.label}-${i}`}>
                            <td>{i + 1}</td>
                            <td>{formatTime(m.timestamp)}</td>
                            <td className="report-mark-label-cell">{m.label}</td>
                            <td>{(m.totalWorkingSetKB / 1024).toFixed(1)}</td>
                            <td>{(m.browserKB / 1024).toFixed(1)}</td>
                            <td>{(m.rendererKB / 1024).toFixed(1)}</td>
                            <td>{(m.gpuKB / 1024).toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 统计摘要 */}
              <div className="report-summary">
                <h3>📊 内存统计摘要</h3>
                <div className="summary-grid">
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.peakTotalMB} MB</span>
                    <span className="summary-label">峰值总内存</span>
                  </div>
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.avgTotalMB} MB</span>
                    <span className="summary-label">平均总内存</span>
                  </div>
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.finalTotalMB} MB</span>
                    <span className="summary-label">末值总内存</span>
                  </div>
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.peakBrowserMB} MB</span>
                    <span className="summary-label">主进程峰值</span>
                  </div>
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.peakRendererMB} MB</span>
                    <span className="summary-label">渲染进程峰值</span>
                  </div>
                  <div className="summary-card">
                    <span className="summary-value">{report.summary.peakProcessCount}</span>
                    <span className="summary-label">最大进程数</span>
                  </div>
                </div>
              </div>

              {resourceSummaryResolved ? (
                <div className="report-summary report-summary--resource">
                  <h3>⚙️ 资源统计摘要（外部监控）</h3>
                  <p className="chart-caption">
                    与 dataPoints 中 ext* 字段一致：CPU/磁盘为<strong>子树汇总</strong>；GPU 为按子树 PID 过滤的 PDH 计数器。
                    共 {resourceSummaryResolved.sampleCount} 个有效采样点参与统计。
                  </p>
                  <div className="summary-grid">
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.peakCpuPercent}%</span>
                      <span className="summary-label">CPU 峰值（子树）</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.avgCpuPercent}%</span>
                      <span className="summary-label">CPU 平均（子树）</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.finalCpuPercent}%</span>
                      <span className="summary-label">CPU 末值（子树）</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.peakDiskReadKBps}</span>
                      <span className="summary-label">磁盘读取峰值 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.avgDiskReadKBps}</span>
                      <span className="summary-label">磁盘读取平均 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.finalDiskReadKBps}</span>
                      <span className="summary-label">磁盘读取末值 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.peakDiskWriteKBps}</span>
                      <span className="summary-label">磁盘写入峰值 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.avgDiskWriteKBps}</span>
                      <span className="summary-label">磁盘写入平均 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">{resourceSummaryResolved.finalDiskWriteKBps}</span>
                      <span className="summary-label">磁盘写入末值 KB/s</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.peakGpuEnginePercent != null
                          ? `${resourceSummaryResolved.peakGpuEnginePercent}%`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 引擎峰值</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.avgGpuEnginePercent != null
                          ? `${resourceSummaryResolved.avgGpuEnginePercent}%`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 引擎平均</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.finalGpuEnginePercent != null
                          ? `${resourceSummaryResolved.finalGpuEnginePercent}%`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 引擎末值</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.peakGpuDedicatedMB != null
                          ? `${resourceSummaryResolved.peakGpuDedicatedMB} MB`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 显存峰值</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.avgGpuDedicatedMB != null
                          ? `${resourceSummaryResolved.avgGpuDedicatedMB} MB`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 显存平均</span>
                    </div>
                    <div className="summary-card">
                      <span className="summary-value">
                        {resourceSummaryResolved.finalGpuDedicatedMB != null
                          ? `${resourceSummaryResolved.finalGpuDedicatedMB} MB`
                          : '—'}
                      </span>
                      <span className="summary-label">GPU 显存末值</span>
                    </div>
                  </div>
                </div>
              ) : null}

              {report.externalTotalMemoryBasis && (
                <div className="report-external-basis">
                  <h3>📎 进程树合计所依据的进程</h3>
                  <p className="section-desc">{report.externalTotalMemoryBasis.note}</p>
                  {report.externalTotalMemoryBasis.includedPids.length === 0 ? (
                    <p className="section-desc">无（全部进程已从合计中排除）</p>
                  ) : (
                    <ul className="pid-basis-list">
                      {report.externalTotalMemoryBasis.includedPids.map((pid) => (
                        <li key={pid}>
                          <code>{pid}</code>
                          {' · '}
                          {report.externalTotalMemoryBasis!.labels[String(pid)] ?? '—'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {/* 趋势分析详情 */}
              <div className="report-trend">
                <h3>📈 趋势分析</h3>
                <div className="trend-details">
                  <div className="trend-row">
                    <span className="trend-key">是否检测到增长趋势</span>
                    <span className={`trend-val ${report.trendAnalysis.hasGrowthTrend ? 'yes' : 'no'}`}>
                      {report.trendAnalysis.hasGrowthTrend ? '是 ⚠️' : '否 ✅'}
                    </span>
                  </div>
                  <div className="trend-row">
                    <span className="trend-key">增长率</span>
                    <span className="trend-val">{report.trendAnalysis.growthRatePerMin} MB/min</span>
                  </div>
                  <div className="trend-row">
                    <span className="trend-key">增长总量</span>
                    <span className="trend-val">{report.trendAnalysis.growthAmountMB} MB</span>
                  </div>
                </div>
              </div>

              {/* 数据点预览 */}
              <div className="report-data-preview">
                <h3>📉 数据采样预览（前20 / 后20 点）</h3>
                {(() => {
                  const hasExtPerf = report.dataPoints.some((d) => d.extCpuPercent !== undefined)
                  return (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>时间</th>
                      <th>总内存(MB)</th>
                      <th>主进程(MB)</th>
                      <th>渲染(MB)</th>
                      <th>GPU(MB)</th>
                      <th>进程数</th>
                      {hasExtPerf ? (
                        <>
                          <th>CPU%(计)</th>
                          <th>读KB/s</th>
                          <th>写KB/s</th>
                          <th>GPU引擎%</th>
                          <th>显存MB</th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {[...report.dataPoints.slice(0, 10), ...report.dataPoints.slice(-10)].map((pt, i) => {
                      const idx = i < 10 ? i : `...${report.dataPoints.length - 10 + i}`
                      return (
                        <tr key={i}>
                          <td>{idx}</td>
                          <td>{formatTime(pt.timestamp)}</td>
                          <td>{pt.totalMB}</td>
                          <td>{pt.browserMB}</td>
                          <td>{pt.rendererMB}</td>
                          <td>{pt.gpuMB}</td>
                          <td>{pt.processCount}</td>
                          {hasExtPerf ? (
                            <>
                              <td>{pt.extCpuPercent ?? '—'}</td>
                              <td>{pt.extDiskReadKBps ?? '—'}</td>
                              <td>{pt.extDiskWriteKBps ?? '—'}</td>
                              <td>{pt.extGpuEnginePercent ?? '—'}</td>
                              <td>{pt.extGpuDedicatedMB ?? '—'}</td>
                            </>
                          ) : null}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                  )
                })()}
              </div>
            </>
          ) : (
            <div className="mmt-empty-state">
              <span className="empty-icon">📋</span>
              <p>选择左侧的历史会话查看详细报告</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

export default ReportPage
