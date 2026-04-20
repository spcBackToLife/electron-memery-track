import React, { useState, useEffect, useCallback, useMemo } from 'react'
import type { TestSession, CompareResult, MemorySnapshot } from '../types'
import { useToast } from '../context/ToastContext'
import CompareDataCharts from '../components/CompareDataCharts'
import { formatSessionSelectLabel } from '../utils/format'
import type { ComparePidSelection, PidCompareRow } from '../utils/comparePidMetrics'
import {
  buildCompareTrendPoints,
  computePidCompareTable,
  getSelectionMetricsRow,
} from '../utils/comparePidMetrics'

/**
 * 回归对比页面 - 选择两次会话进行对比
 * 进程维度按「命令行 → 镜像路径 → 进程名 → PID」聚合，避免两次运行 PID 不同无法对应
 */
const ComparePage: React.FC = () => {
  const [sessions, setSessions] = useState<TestSession[]>([])
  const [baseId, setBaseId] = useState<string>('')
  const [targetId, setTargetId] = useState<string>('')
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null)
  const [comparing, setComparing] = useState(false)
  const [snapPair, setSnapPair] = useState<{
    base: MemorySnapshot[]
    target: MemorySnapshot[]
  } | null>(null)
  const [pidRows, setPidRows] = useState<PidCompareRow[]>([])
  const [selectedCompare, setSelectedCompare] = useState<ComparePidSelection>('aggregate')
  const { showToast } = useToast()

  const loadSessions = useCallback(async () => {
    try {
      const list = (await window.monitorAPI.listSessions()) as TestSession[]
      setSessions(list.filter((s) => s.status === 'completed'))
    } catch (err) {
      console.error('[ComparePage] Failed to load sessions:', err)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const compareTrend = useMemo(() => {
    if (!snapPair) return []
    return buildCompareTrendPoints(snapPair.base, snapPair.target, selectedCompare)
  }, [snapPair, selectedCompare])

  const selectionRow = useMemo(() => {
    if (!snapPair) return null
    return getSelectionMetricsRow(snapPair.base, snapPair.target, selectedCompare)
  }, [snapPair, selectedCompare])

  const sessionOptionLabel = (s: TestSession) =>
    `${s.label}（${formatSessionSelectLabel(s.startTime)}）`

  const handleCompare = async () => {
    if (!baseId || !targetId || baseId === targetId) {
      showToast('请选择两个不同的会话', 'warning')
      return
    }

    setComparing(true)
    setSnapPair(null)
    setPidRows([])
    setSelectedCompare('aggregate')
    try {
      const result = (await window.monitorAPI.compareSessions(baseId, targetId)) as CompareResult | null
      const baseSn = (await window.monitorAPI.getSessionSnapshots(baseId, 800)) as MemorySnapshot[]
      const targetSn = (await window.monitorAPI.getSessionSnapshots(targetId, 800)) as MemorySnapshot[]

      setCompareResult(result)
      setSnapPair({ base: baseSn, target: targetSn })
      setPidRows(computePidCompareTable(baseSn, targetSn))

      if (result) {
        showToast('对比完成', 'success')
      } else {
        showToast('无法生成对比结果（可能缺少报告数据）', 'error')
      }
    } catch (err) {
      console.error('[ComparePage] Compare failed:', err)
      showToast('对比失败', 'error')
    } finally {
      setComparing(false)
    }
  }

  const verdictConfig: Record<string, { label: string; color: string; bg: string; icon: string }> = {
    REGRESSION: { label: '回归！', color: '#ff4d4f', bg: 'rgba(255,77,79,0.08)', icon: '🔴' },
    IMPROVED: { label: '改善', color: '#52c41a', bg: 'rgba(82,193,26,0.08)', icon: '🟢' },
    STABLE: { label: '稳定', color: '#1890ff', bg: 'rgba(24,144,255,0.08)', icon: '🔵' },
    INCONCLUSIVE: { label: '待定', color: '#faad14', bg: 'rgba(250,173,20,0.08)', icon: '🟡' },
  }

  const chartTitle =
    selectedCompare === 'aggregate'
      ? '📈 会话合计内存曲线（全部 PID 之和）'
      : `📈 进程内存曲线 · ${pidRows.find((r) => r.identityKey === selectedCompare)?.label ?? '已选进程'}`

  const fmtDiff = (v: number) => (v > 0 ? `+${v}` : `${v}`)
  const fmtPctNum = (v: number) => (v > 0 ? `+${v}` : `${v}`)
  const fmtPctCell = (v: number | null) => (v === null ? '—' : `${fmtPctNum(v)}%`)
  const pctWarn = (v: number | null) => v != null && Math.abs(v) > 10

  return (
    <div className="mmt-compare-page">
      <div className="compare-selector">
        <h3>⚖️ 选择要对比的两次测试</h3>
        <p className="section-desc">
          选择基线版本和目标版本的测试会话，系统将自动计算差异并给出回归判定。分进程对比优先按
          <strong>命令行</strong>、其次<strong>镜像路径</strong>对齐（两次运行 PID 不同也能合并为一行）；无命令行/路径时回退为进程名或
          PID。
        </p>
        <div className="selector-row">
          <div className="selector-group">
            <label>📌 基线版本（Baseline）</label>
            <select value={baseId} onChange={(e) => setBaseId(e.target.value)}>
              <option value="">-- 请选择 --</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionOptionLabel(s)}
                </option>
              ))}
            </select>
          </div>

          <div className="vs-badge">VS</div>

          <div className="selector-group">
            <label>🎯 目标版本（Target）</label>
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">-- 请选择 --</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionOptionLabel(s)}
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn btn-primary compare-btn"
            onClick={handleCompare}
            disabled={!baseId || !targetId || baseId === targetId || comparing}
          >
            {comparing ? '⏳ 对比中...' : '🔍 开始对比'}
          </button>
        </div>
      </div>

      {snapPair && (
        <div className="compare-result">
          <div className="compare-pid-toolbar">
            <label>对比维度（曲线与下方「当前选择」数值表）</label>
            <select
              className="compare-pid-select"
              value={selectedCompare === 'aggregate' ? '' : encodeURIComponent(selectedCompare)}
              onChange={(e) => {
                const v = e.target.value
                setSelectedCompare(v === '' ? 'aggregate' : decodeURIComponent(v))
              }}
            >
              <option value="">会话合计（全部 PID 之和）</option>
              {pidRows.map((row) => (
                <option key={row.identityKey} value={encodeURIComponent(row.identityKey)}>
                  {row.label}
                </option>
              ))}
            </select>
            <p className="compare-pid-hint">
              下方表格按进程身份聚合；点击行可切换上方曲线与「当前选择」数值表。旧会话若无命令行/路径字段，可能仍按名称或
              PID 区分。
            </p>
          </div>

          {compareTrend.length >= 2 && (
            <CompareDataCharts
              points={compareTrend}
              title={chartTitle}
              baseLabel={`基线: ${sessions.find((x) => x.id === baseId)?.label ?? baseId}`}
              targetLabel={`目标: ${sessions.find((x) => x.id === targetId)?.label ?? targetId}`}
            />
          )}

          {compareResult && (
            <div className="verdict-section" style={{ background: verdictConfig[compareResult.verdict.status].bg }}>
              <h3>
                {verdictConfig[compareResult.verdict.status].icon}
                {' '}
                对比结论（会话级 · 基于测试报告摘要）：
                <span
                  className="verdict-label"
                  style={{ color: verdictConfig[compareResult.verdict.status].color }}
                >
                  {verdictConfig[compareResult.verdict.status].label}
                </span>
              </h3>
              <p className="verdict-summary">{compareResult.verdict.summary}</p>
            </div>
          )}

          {selectionRow && (
            <div className="comparison-metrics">
              <h3>📊 数值对比（当前选择：{selectionRow.label}）</h3>
              <table className="compare-table">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>基线 (MB)</th>
                    <th>目标 (MB)</th>
                    <th>差值</th>
                    <th>变化率</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>峰值内存</td>
                    <td>{selectionRow.peakBaseMB}</td>
                    <td>{selectionRow.peakTargetMB}</td>
                    <td className={selectionRow.peakDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                      {fmtDiff(selectionRow.peakDiffMB)} MB
                    </td>
                    <td
                      className={
                        selectionRow.peakChangePercent != null && selectionRow.peakChangePercent > 0
                          ? 'diff-bad'
                          : 'diff-good'
                      }
                    >
                      {fmtPctCell(selectionRow.peakChangePercent)}
                    </td>
                    <td>{pctWarn(selectionRow.peakChangePercent) ? '⚠️' : '✅'}</td>
                  </tr>
                  <tr>
                    <td>平均内存</td>
                    <td>{selectionRow.avgBaseMB}</td>
                    <td>{selectionRow.avgTargetMB}</td>
                    <td className={selectionRow.avgDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                      {fmtDiff(selectionRow.avgDiffMB)} MB
                    </td>
                    <td
                      className={
                        selectionRow.avgChangePercent != null && selectionRow.avgChangePercent > 0
                          ? 'diff-bad'
                          : 'diff-good'
                      }
                    >
                      {fmtPctCell(selectionRow.avgChangePercent)}
                    </td>
                    <td>{pctWarn(selectionRow.avgChangePercent) ? '⚠️' : '✅'}</td>
                  </tr>
                  <tr>
                    <td>末值内存</td>
                    <td>{selectionRow.finalBaseMB}</td>
                    <td>{selectionRow.finalTargetMB}</td>
                    <td className={selectionRow.finalDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                      {fmtDiff(selectionRow.finalDiffMB)} MB
                    </td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {pidRows.length > 0 && (
            <div className="comparison-metrics compare-pid-full-block">
              <h3>📋 全进程对比（对齐采样后按命令行 / 镜像路径聚合）</h3>
              <div className="compare-pid-full-table-wrap">
                <table className="compare-table compare-pid-full-table">
                  <thead>
                    <tr>
                      <th>进程</th>
                      <th>标识说明</th>
                      <th>峰值Δ</th>
                      <th>峰值%</th>
                      <th>均值Δ</th>
                      <th>均值%</th>
                      <th>末值Δ</th>
                      <th>峰值基线</th>
                      <th>峰值目标</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pidRows.map((row) => (
                      <tr
                        key={row.identityKey}
                        className={`compare-pid-row ${selectedCompare === row.identityKey ? 'selected' : ''}`}
                        onClick={() => setSelectedCompare(row.identityKey)}
                      >
                        <td title={row.detail}>{row.label}</td>
                        <td className="compare-identity-detail" title={row.detail}>
                          {row.detail
                            ? row.detail.length > 56
                              ? `${row.detail.slice(0, 54)}…`
                              : row.detail
                            : row.identityKey.startsWith('pid:')
                              ? `仅 PID：${row.identityKey.slice(4)}`
                              : '—'}
                        </td>
                        <td className={row.peakDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                          {fmtDiff(row.peakDiffMB)}
                        </td>
                        <td
                          className={
                            row.peakChangePercent != null && row.peakChangePercent > 0 ? 'diff-bad' : 'diff-good'
                          }
                        >
                          {fmtPctCell(row.peakChangePercent)}
                        </td>
                        <td className={row.avgDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                          {fmtDiff(row.avgDiffMB)}
                        </td>
                        <td
                          className={
                            row.avgChangePercent != null && row.avgChangePercent > 0 ? 'diff-bad' : 'diff-good'
                          }
                        >
                          {fmtPctCell(row.avgChangePercent)}
                        </td>
                        <td className={row.finalDiffMB > 0 ? 'diff-bad' : 'diff-good'}>
                          {fmtDiff(row.finalDiffMB)}
                        </td>
                        <td>{row.peakBaseMB}</td>
                        <td>{row.peakTargetMB}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {compareResult && (
            <div className="verdict-details">
              <h3>🔍 判定依据</h3>
              <ul className="details-list">
                {compareResult.verdict.details.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
              {compareResult.verdict.details.length === 0 && (
                <p>数据不足，无法做出明确判断。</p>
              )}
            </div>
          )}

          <div className="compare-session-info">
            <div className="info-box">
              <h4>📌 基线</h4>
              <p>{sessions.find((x) => x.id === baseId)?.label ?? baseId}</p>
              <code>{baseId}</code>
            </div>
            <div className="info-arrow">→</div>
            <div className="info-box">
              <h4>🎯 目标</h4>
              <p>{sessions.find((x) => x.id === targetId)?.label ?? targetId}</p>
              <code>{targetId}</code>
            </div>
          </div>
        </div>
      )}

      {!compareResult && sessions.length >= 2 && (
        <div className="compare-hint">
          <p>💡 提示：选择两个不同版本的测试会话即可开始对比。建议在相同的操作流程下分别录制。</p>
        </div>
      )}

      {sessions.length < 2 && (
        <div className="compare-hint">
          <p>需要至少 2 个已完成的会话才能进行对比。请先在「实时监控」页面结束几次会话。</p>
        </div>
      )}
    </div>
  )
}

export default ComparePage
