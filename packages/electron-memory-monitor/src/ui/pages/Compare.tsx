import React, { useEffect, useState } from 'react'
import { useSession } from '../hooks/useSession'
import type { TestSession } from '../../types/session'
import type { CompareReport } from '../../types/report'

const formatKB = (kb: number): string => {
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const Compare: React.FC = () => {
  const { sessions, refreshSessions, compareSessions } = useSession()
  const [baseId, setBaseId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [report, setReport] = useState<CompareReport | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  const handleCompare = async () => {
    if (!baseId || !targetId) return
    setLoading(true)
    try {
      const r = await compareSessions(baseId, targetId)
      setReport(r as CompareReport)
    } catch (err) {
      console.error('Compare failed:', err)
    }
    setLoading(false)
  }

  const completedSessions = sessions.filter((s) => s.status === 'completed')

  const verdictConfig = {
    pass: { icon: '✅', color: '#52c41a', label: 'PASS - 通过' },
    warn: { icon: '🟡', color: '#faad14', label: 'WARN - 存在轻微劣化' },
    fail: { icon: '🔴', color: '#ff4d4f', label: 'FAIL - 存在严重劣化' },
  }

  return (
    <div className="compare-page">
      <h2>🔄 迭代对比</h2>

      {/* 选择会话 */}
      <div className="compare-selector">
        <div className="compare-select-group">
          <label>基准会话 (旧版本)</label>
          <select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            <option value="">-- 选择基准会话 --</option>
            {completedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({new Date(s.startTime).toLocaleDateString()})
              </option>
            ))}
          </select>
        </div>

        <span className="compare-arrow">→</span>

        <div className="compare-select-group">
          <label>对比会话 (新版本)</label>
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">-- 选择对比会话 --</option>
            {completedSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({new Date(s.startTime).toLocaleDateString()})
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn btn-primary"
          onClick={handleCompare}
          disabled={!baseId || !targetId || loading}
        >
          {loading ? '对比中...' : '开始对比'}
        </button>
      </div>

      {/* 对比结果 */}
      {report && (
        <div className="compare-result">
          {/* 综合判定 */}
          <div
            className="compare-verdict"
            style={{ borderColor: verdictConfig[report.verdict].color }}
          >
            <span className="verdict-icon">{verdictConfig[report.verdict].icon}</span>
            <span className="verdict-label" style={{ color: verdictConfig[report.verdict].color }}>
              {verdictConfig[report.verdict].label}
            </span>
            <p className="verdict-reason">{report.verdictReason}</p>
          </div>

          {/* 指标对比表 */}
          <div className="compare-section">
            <h3>📊 指标对比</h3>
            <table className="compare-table">
              <thead>
                <tr>
                  <th>指标</th>
                  <th>{report.base.label}</th>
                  <th>{report.target.label}</th>
                  <th>变化</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { name: '总内存 (avg)', diff: report.overall.totalMemory, isBytes: false },
                  { name: '主进程 (avg)', diff: report.overall.browserMemory, isBytes: false },
                  { name: '渲染进程 (avg)', diff: report.overall.rendererMemory, isBytes: false },
                  ...(report.overall.gpuMemory ? [{ name: 'GPU (avg)', diff: report.overall.gpuMemory, isBytes: false }] : []),
                  { name: 'V8 Heap Used', diff: report.v8Heap.heapUsed, isBytes: true },
                  { name: 'V8 Heap Total', diff: report.v8Heap.heapTotal, isBytes: true },
                  { name: 'V8 External', diff: report.v8Heap.external, isBytes: true },
                ].map((row) => {
                  const statusIcon = row.diff.status === 'improved' ? '✅' :
                    row.diff.status === 'degraded' ? '🔴' : '➖'
                  const fmt = row.isBytes ? formatBytes : formatKB
                  return (
                    <tr key={row.name} className={`status-${row.diff.status}`}>
                      <td>{row.name}</td>
                      <td>{fmt(row.diff.base)}</td>
                      <td>{fmt(row.diff.target)}</td>
                      <td className={row.diff.deltaPercent > 5 ? 'degraded' : row.diff.deltaPercent < -3 ? 'improved' : ''}>
                        {row.diff.deltaPercent > 0 ? '+' : ''}{row.diff.deltaPercent.toFixed(1)}%
                      </td>
                      <td>{statusIcon}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 趋势变化 */}
          <div className="compare-section">
            <h3>📈 趋势变化</h3>
            <div className="trend-changes">
              {report.trendChanges.map((tc) => {
                const changeIcon = tc.change === 'improved' ? '✅' :
                  tc.change === 'degraded' ? '🔴' : '➖'
                return (
                  <div key={tc.metric} className={`trend-change-item ${tc.change}`}>
                    <span className="trend-change-metric">{tc.metric}</span>
                    <span>基准: {tc.baseSlope.toFixed(2)} KB/s</span>
                    <span>目标: {tc.targetSlope.toFixed(2)} KB/s</span>
                    <span>{changeIcon}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 劣化项 */}
          {report.regressions.length > 0 && (
            <div className="compare-section">
              <h3>⚠️ 劣化项 ({report.regressions.length})</h3>
              <div className="regression-list">
                {report.regressions.map((r, i) => (
                  <div key={i} className={`regression-item severity-${r.severity}`}>
                    <div className="regression-header">
                      <span className="regression-metric">{r.metric}</span>
                      <span className="regression-delta">+{r.deltaPercent.toFixed(1)}%</span>
                      <span className={`regression-severity ${r.severity}`}>{r.severity}</span>
                    </div>
                    <p className="regression-desc">{r.description}</p>
                    <p className="regression-suggestion">💡 {r.suggestion}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 改进项 */}
          {report.improvements.length > 0 && (
            <div className="compare-section">
              <h3>✅ 改进项 ({report.improvements.length})</h3>
              <div className="improvement-list">
                {report.improvements.map((imp, i) => (
                  <div key={i} className="improvement-item">
                    <span className="improvement-metric">{imp.metric}</span>
                    <span className="improvement-delta">{imp.deltaPercent.toFixed(1)}%</span>
                    <span className="improvement-desc">{imp.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default Compare
