import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { MemorySnapshot, ReportSummary, TestSession } from '../types'
import { formatDuration } from '../utils/format'
import { collectReportEventMarksFromSnapshots } from '../utils/reportEventMarks'
import { groupSessionsIntoBatches, type BatchGroup } from '../utils/batchReportGrouping'
import {
  annotateOutliers,
  buildRunSummaryRow,
  computeBaselineStats,
  type BatchRunSummaryRow,
} from '../utils/batchReportMetrics'
import {
  collectBatchProcessOptions,
  type BatchRunLoaded,
} from '../utils/batchMultiRunCharts'
import type { ComparePidSelection } from '../utils/comparePidMetrics'
import BatchMultiRunCharts from '../components/BatchMultiRunCharts'
import { useToast } from '../context/ToastContext'

const BatchReportPage: React.FC = () => {
  const { showToast } = useToast()
  const [groups, setGroups] = useState<BatchGroup[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<BatchRunSummaryRow[]>([])
  const [loadedRuns, setLoadedRuns] = useState<BatchRunLoaded[]>([])
  const [processSelection, setProcessSelection] = useState<ComparePidSelection>('aggregate')

  const loadGroups = useCallback(async () => {
    try {
      const list = await window.monitorAPI.listSessions() as TestSession[]
      const batches = groupSessionsIntoBatches(list).filter((g) => g.runs.length >= 2)
      setGroups(batches)
      if (!selectedKey && batches.length > 0) {
        setSelectedKey(batches[0]!.batchKey)
      }
    } catch (err) {
      console.error('[BatchReportPage] load groups failed:', err)
    }
  }, [selectedKey])

  const selectedGroup = useMemo(
    () => groups.find((g) => g.batchKey === selectedKey) ?? null,
    [groups, selectedKey],
  )

  const loadBatchData = useCallback(async (group: BatchGroup) => {
    setLoading(true)
    try {
      const loaded: BatchRunLoaded[] = []
      const summaryRows: BatchRunSummaryRow[] = []

      for (let i = 0; i < group.runs.length; i++) {
        const meta = group.runs[i]!
        const runIndex = meta.runIndex ?? i + 1
        const [report, snapshots] = await Promise.all([
          window.monitorAPI.getSessionReport(meta.sessionId) as Promise<ReportSummary | null>,
          window.monitorAPI.getSessionSnapshots(meta.sessionId, 2000) as Promise<MemorySnapshot[]>,
        ])
        if (!report) continue
        const snaps = snapshots ?? []
        const marks = report.eventMarks ?? collectReportEventMarksFromSnapshots(snaps)
        loaded.push({
          sessionId: meta.sessionId,
          runIndex,
          label: report.label,
          shortLabel: report.label,
          report,
          snapshots: snaps,
          marks,
        })
        summaryRows.push(buildRunSummaryRow(report, runIndex))
      }

      const withOutliers = annotateOutliers(summaryRows)
      setLoadedRuns(loaded)
      setRows(withOutliers)
      setProcessSelection('aggregate')
    } catch (err) {
      console.error('[BatchReportPage] load batch failed:', err)
      showToast('加载批次数据失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadGroups()
  }, [loadGroups])

  useEffect(() => {
    if (selectedGroup) void loadBatchData(selectedGroup)
  }, [selectedGroup, loadBatchData])

  const activeRows = useMemo(() => rows, [rows])
  const includedRows = useMemo(() => activeRows.filter((r) => !r.excluded), [activeRows])
  const baselineStats = useMemo(
    () => computeBaselineStats(activeRows, true),
    [activeRows],
  )

  const includedRuns = useMemo(() => {
    const excluded = new Set(activeRows.filter((r) => r.excluded).map((r) => r.sessionId))
    return loadedRuns.filter((r) => !excluded.has(r.sessionId))
  }, [loadedRuns, activeRows])

  const processOptions = useMemo(
    () => collectBatchProcessOptions(includedRuns),
    [includedRuns],
  )

  const toggleExclude = (sessionId: string) => {
    setRows((prev) => prev.map((r) => (
      r.sessionId === sessionId ? { ...r, excluded: !r.excluded } : r
    )))
  }

  const includeAllRuns = () => {
    setRows((prev) => prev.map((r) => ({ ...r, excluded: false })))
  }

  const excludeOutlierRuns = () => {
    setRows((prev) => prev.map((r) => ({
      ...r,
      excluded: r.outlierReasons.length > 0,
    })))
  }

  const conclusionIcon: Record<string, string> = { PASS: '✅', WARN: '⚠️', FAIL: '❌' }

  return (
    <div className="mmt-report-page mmt-batch-report-page">
      <div className="report-layout">
        <aside className="report-sidebar">
          <h3>📦 批量批次 ({groups.length})</h3>
          <p className="chart-caption batch-sidebar-hint">
            自动按会话名前缀分组（<code>前缀-应用-runN-时间</code>），仅显示 ≥2 轮的批次。
          </p>
          <div className="session-list">
            {groups.map((g) => (
              <div
                key={g.batchKey}
                className={`session-item ${selectedKey === g.batchKey ? 'active' : ''}`}
                onClick={() => setSelectedKey(g.batchKey)}
              >
                <span className="session-label">{g.batchKey}</span>
                <span className="session-time">{g.runs.length} 轮 · 最近 {new Date(g.runs[g.runs.length - 1]!.startTime).toLocaleString()}</span>
              </div>
            ))}
            {groups.length === 0 && (
              <div className="session-empty">
                暂无批量批次。请在「自动化测试」页执行多轮测试（重复次数 ≥2）。
              </div>
            )}
          </div>
        </aside>

        <main className="report-detail">
          {loading ? (
            <div className="mmt-loading"><div className="loading-spinner" /><p>加载批次数据…</p></div>
          ) : selectedGroup && rows.length > 0 ? (
            <>
              <div className="report-header">
                <h2>📦 {selectedGroup.batchKey}</h2>
                <div className="report-meta">
                  <span>🔁 {selectedGroup.runs.length} 轮测试</span>
                  <span>📊 纳入基线 {includedRows.length} 轮</span>
                  <span>🏷️ 前缀 {selectedGroup.prefix}</span>
                </div>
              </div>

              <div className="batch-run-filter-panel">
                <div className="batch-run-filter-header">
                  <h3>🎯 纳入对比的会话</h3>
                  <div className="batch-run-filter-actions">
                    <button type="button" className="btn btn-sm btn-secondary" onClick={includeAllRuns}>
                      全选
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={excludeOutlierRuns}>
                      排除离群
                    </button>
                  </div>
                </div>
                <p className="chart-caption">
                  取消勾选异常轮次后，下方基线统计、汇总表高亮与趋势折线图仅使用剩余会话（至少保留 2 个才有折线对比）。
                </p>
                <div className="batch-run-chip-list">
                  {activeRows.map((r) => (
                    <label
                      key={r.sessionId}
                      className={`batch-run-chip ${r.excluded ? 'batch-run-chip--off' : ''} ${r.outlierReasons.length > 0 ? 'batch-run-chip--outlier' : ''}`}
                      title={r.label}
                    >
                      <input
                        type="checkbox"
                        checked={!r.excluded}
                        onChange={() => toggleExclude(r.sessionId)}
                      />
                      <span className="batch-run-chip-text">{r.label}</span>
                      {r.outlierReasons.length > 0 && (
                        <span className="batch-run-chip-tag">离群</span>
                      )}
                    </label>
                  ))}
                </div>
                {includedRows.length < 2 && (
                  <p className="batch-coverage-warn">
                    当前仅纳入 {includedRows.length} 个会话，趋势对比需要至少 2 个；请勾选更多会话或全选。
                  </p>
                )}
              </div>

              <div className="batch-baseline-panel">
                <h3>📐 基线统计（已纳入 {includedRows.length} 轮）</h3>
                <p className="chart-caption">
                  基于上方已勾选的会话重算。中位数接近「典型值」，标准差大说明环境波动明显。
                </p>
                <div className="summary-grid batch-baseline-grid">
                  {baselineStats.map((s) => (
                    <div key={s.metric} className="summary-card">
                      <span className="summary-value">{s.median} {s.unit}</span>
                      <span className="summary-label">{s.label} 中位数</span>
                      <span className="batch-stat-sub">均值 {s.mean} · σ {s.stdDev} · [{s.min}–{s.max}]</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="batch-runs-table-section">
                <h3>📋 各轮汇总表</h3>
                <p className="chart-caption">
                  与顶部「纳入对比」同步。灰色行为已排除；离群轮次（IQR 法）会标注。
                </p>
                <div className="batch-table-scroll">
                  <table className="data-table batch-runs-table">
                    <thead>
                      <tr>
                        <th>纳入</th>
                        <th>会话名</th>
                        <th>结论</th>
                        <th>时长</th>
                        <th colSpan={3}>总内存 MB</th>
                        <th colSpan={3}>专用提交 MB</th>
                        <th>主进程峰</th>
                        <th>渲染峰</th>
                        <th colSpan={3}>CPU %</th>
                        <th colSpan={3}>GPU 引擎 %</th>
                        <th colSpan={3}>显存 MB</th>
                        <th>离群</th>
                      </tr>
                      <tr className="batch-subhead">
                        <th colSpan={5} />
                        <th>峰</th><th>均</th><th>末</th>
                        <th>峰</th><th>均</th><th>末</th>
                        <th colSpan={2} />
                        <th>峰</th><th>均</th><th>末</th>
                        <th>峰</th><th>均</th><th>末</th>
                        <th>峰</th><th>均</th><th>末</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {activeRows.map((r) => (
                        <tr key={r.sessionId} className={r.excluded ? 'batch-row-excluded' : r.outlierReasons.length > 0 ? 'batch-row-outlier' : ''}>
                          <td>
                            <input
                              type="checkbox"
                              checked={!r.excluded}
                              onChange={() => toggleExclude(r.sessionId)}
                              title="纳入基线统计与折线图"
                            />
                          </td>
                          <td className="batch-session-label-cell" title={r.label}>{r.label}</td>
                          <td>{conclusionIcon[r.conclusion] ?? ''} {r.conclusion}</td>
                          <td>{formatDuration(r.durationMs)}</td>
                          <td>{r.peakTotalMB}</td>
                          <td>{r.avgTotalMB}</td>
                          <td>{r.finalTotalMB}</td>
                          <td>{r.peakPrivateMB ?? '—'}</td>
                          <td>{r.avgPrivateMB ?? '—'}</td>
                          <td>{r.finalPrivateMB ?? '—'}</td>
                          <td>{r.peakBrowserMB}</td>
                          <td>{r.peakRendererMB}</td>
                          <td>{r.peakCpu ?? '—'}</td>
                          <td>{r.avgCpu ?? '—'}</td>
                          <td>{r.finalCpu ?? '—'}</td>
                          <td>{r.peakGpu ?? '—'}</td>
                          <td>{r.avgGpu ?? '—'}</td>
                          <td>{r.finalGpu ?? '—'}</td>
                          <td>{r.peakVram ?? '—'}</td>
                          <td>{r.avgVram ?? '—'}</td>
                          <td>{r.finalVram ?? '—'}</td>
                          <td className="batch-outlier-cell">
                            {r.outlierReasons.length > 0 ? r.outlierReasons.join('、') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="batch-charts-section">
                <h3>📈 趋势对比（多轮叠加）</h3>
                <div className="batch-process-picker">
                  <label className="batch-process-picker-label">
                    进程视角
                    <select
                      className="batch-process-select"
                      value={processSelection}
                      onChange={(e) => setProcessSelection(
                        e.target.value === 'aggregate' ? 'aggregate' : e.target.value,
                      )}
                    >
                      <option value="aggregate">子树合计（总内存）</option>
                      {processOptions.map((p) => (
                        <option
                          key={p.identityKey}
                          value={p.identityKey}
                          title={`${p.typeLabel} · 峰 ${p.peakMB.toFixed(0)} MB · ${p.runCoverage}/${p.totalRuns} 轮有数据\n${p.cmdFull || p.cmdPreview}`}
                        >
                          {p.optionLabel}
                        </option>
                      ))}
                    </select>
                  </label>
                  {processSelection !== 'aggregate' && (() => {
                    const sel = processOptions.find((p) => p.identityKey === processSelection)
                    if (!sel) return null
                    return (
                      <div className="batch-process-cmd-preview">
                        <span className={`batch-type-badge batch-type-badge--${sel.typeLabel}`}>
                          {sel.typeLabel}
                        </span>
                        <code className="batch-cmd-text" title={sel.cmdFull}>{sel.cmdPreview}</code>
                        {sel.runCoverage < sel.totalRuns && (
                          <span className="batch-coverage-warn">
                            仅 {sel.runCoverage}/{sel.totalRuns} 轮有数据，未出现的轮次折线为 0
                          </span>
                        )}
                      </div>
                    )
                  })()}
                  <span className="chart-caption">
                    跨轮按 Chromium 角色 + 归一化命令行匹配（去掉 PID/句柄等每轮变化的参数），与实时监控进程表的 type 标签一致。
                  </span>
                </div>
                {includedRuns.length >= 2 ? (
                  <BatchMultiRunCharts runs={includedRuns} processSelection={processSelection} />
                ) : (
                  <p className="chart-caption">请至少在顶部勾选 2 个会话后再查看趋势对比。</p>
                )}
              </div>
            </>
          ) : (
            <div className="session-empty">请选择左侧批次，或先完成多轮自动化测试。</div>
          )}
        </main>
      </div>
    </div>
  )
}

export default BatchReportPage
