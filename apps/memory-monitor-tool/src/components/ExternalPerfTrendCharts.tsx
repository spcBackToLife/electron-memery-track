import React, { useMemo } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import type { MemorySnapshot, ReportSummary } from '../types'
import { downsampleUniform } from '../utils/chartDecimate'

const MAX_PERF_CHART_POINTS = 360

const formatTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

export type ExternalPerfRow = {
  timestamp: number
  cpu: number
  diskRead: number
  diskWrite: number
  gpu: number | null
  vram: number | null
}

export type ExternalPerfLayout = 'compact' | 'featured'

interface ExternalPerfTrendChartsProps {
  snapshots?: MemorySnapshot[]
  rows?: ExternalPerfRow[]
  /** compact：侧栏小图；featured：整行大图 + 时间轴 */
  layout?: ExternalPerfLayout
}

function rowsFromSnapshots(snapshots: MemorySnapshot[]): ExternalPerfRow[] {
  return snapshots
    .filter((s) => s.monitorMode === 'external' && s.externalMetrics)
    .map((s) => {
      const m = s.externalMetrics!
      return {
        timestamp: s.timestamp,
        cpu: Math.round(m.aggregateCpuPercent * 100) / 100,
        diskRead: Math.round(m.diskReadKBps * 100) / 100,
        diskWrite: Math.round(m.diskWriteKBps * 100) / 100,
        gpu: m.gpuEnginePercent != null ? Math.round(m.gpuEnginePercent * 10) / 10 : null,
        vram: m.gpuDedicatedMB != null ? Math.round(m.gpuDedicatedMB * 10) / 10 : null,
      }
    })
}

export function rowsFromReportDataPoints(
  dataPoints: ReportSummary['dataPoints'],
): ExternalPerfRow[] {
  return dataPoints
    .filter((d) => d.extCpuPercent !== undefined)
    .map((d) => ({
      timestamp: d.timestamp,
      cpu: Math.round((d.extCpuPercent ?? 0) * 100) / 100,
      diskRead: Math.round((d.extDiskReadKBps ?? 0) * 100) / 100,
      diskWrite: Math.round((d.extDiskWriteKBps ?? 0) * 100) / 100,
      gpu: d.extGpuEnginePercent != null ? Math.round(d.extGpuEnginePercent * 10) / 10 : null,
      vram: d.extGpuDedicatedMB != null ? Math.round(d.extGpuDedicatedMB * 10) / 10 : null,
    }))
}

const tip = {
  background: 'rgba(26, 28, 38, 0.96)',
  border: '1px solid rgba(100,108,255,0.25)',
  borderRadius: 8,
  color: '#e0e0e0',
  fontSize: 12,
}

/**
 * CPU / 磁盘读写 / GPU 利用率 / 显存 — 单会话时间序列
 */
const ExternalPerfTrendCharts: React.FC<ExternalPerfTrendChartsProps> = ({
  snapshots,
  rows: rowsProp,
  layout = 'compact',
}) => {
  const chartRows = useMemo(() => {
    let rows: ExternalPerfRow[] = []
    if (rowsProp && rowsProp.length > 0) rows = rowsProp
    else if (snapshots && snapshots.length > 0) rows = rowsFromSnapshots(snapshots)
    if (rows.length > MAX_PERF_CHART_POINTS) {
      return downsampleUniform(rows, MAX_PERF_CHART_POINTS)
    }
    return rows
  }, [snapshots, rowsProp])

  if (chartRows.length < 2) return null

  const tMin = chartRows[0]?.timestamp ?? 0
  const tMax = chartRows[chartRows.length - 1]?.timestamp ?? 0
  const featured = layout === 'featured'
  const h = featured ? 200 : 118
  const axisFont = featured ? 11 : 10
  const showX = featured

  const xAxisShared = (
    <XAxis
      type="number"
      dataKey="timestamp"
      domain={[tMin, tMax]}
      hide={!showX}
      stroke="rgba(255,255,255,0.45)"
      fontSize={axisFont}
      tickFormatter={(ts: number) => formatTime(ts)}
    />
  )

  const wrap = (label: string, node: React.ReactNode) => (
    <div className={`external-perf-cell ${featured ? 'external-perf-cell--featured' : ''}`}>
      <span className="external-perf-cell-label">{label}</span>
      {node}
    </div>
  )

  return (
    <div className={`external-perf-charts ${featured ? 'external-perf-charts--featured' : ''}`}>
      {!featured ? (
        <h4 className="external-perf-charts-title">外部进程树 · CPU / 磁盘 / GPU</h4>
      ) : null}
      <p className="chart-caption">
        CPU 与磁盘为<strong>子树内全部 PID</strong>之和（KB/s）；相邻采样差分，<strong>首拍 CPU/磁盘为 0</strong>。
        GPU%、显存为 PDH 按<strong>子树 PID</strong>过滤后的汇总（与任务管理器进程列同源）。
      </p>
      <div
        className={featured ? 'external-perf-chart-grid--featured' : 'external-perf-chart-grid'}
        style={{ width: '100%', minWidth: 0 }}
      >
        {wrap(
          'CPU 合计 %',
          <ResponsiveContainer width="100%" height={h}>
            <LineChart data={chartRows} margin={{ top: 6, right: 10, left: 4, bottom: showX ? 22 : 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              {xAxisShared}
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={axisFont} width={featured ? 42 : 36} />
              <Tooltip contentStyle={tip} labelFormatter={(ts) => formatTime(Number(ts))} formatter={(v: number) => [`${v.toFixed(1)} %`, 'CPU']} />
              <Legend wrapperStyle={{ fontSize: featured ? 11 : 10 }} />
              <Line type="monotone" dataKey="cpu" name="CPU%" stroke="#52c41a" dot={false} strokeWidth={featured ? 2 : 1.6} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {wrap(
          '磁盘读写 KB/s',
          <ResponsiveContainer width="100%" height={h}>
            <LineChart data={chartRows} margin={{ top: 6, right: 10, left: 4, bottom: showX ? 22 : 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              {xAxisShared}
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={axisFont} width={featured ? 42 : 36} />
              <Tooltip contentStyle={tip} labelFormatter={(ts) => formatTime(Number(ts))} formatter={(v: number, n: string) => [`${v.toFixed(1)} KB/s`, n]} />
              <Legend wrapperStyle={{ fontSize: featured ? 11 : 10 }} />
              <Line type="monotone" dataKey="diskRead" name="读取" stroke="#faad14" dot={false} strokeWidth={featured ? 2 : 1.5} isAnimationActive={false} />
              <Line type="monotone" dataKey="diskWrite" name="写入" stroke="#eb2f96" dot={false} strokeWidth={featured ? 2 : 1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {wrap(
          'GPU 总使用率 %',
          <ResponsiveContainer width="100%" height={h}>
            <LineChart data={chartRows} margin={{ top: 6, right: 10, left: 4, bottom: showX ? 22 : 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              {xAxisShared}
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={axisFont} width={featured ? 42 : 36} domain={[0, 'auto']} />
              <Tooltip
                contentStyle={tip}
                labelFormatter={(ts) => formatTime(Number(ts))}
                formatter={(value: unknown) => {
                  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return ['—', 'GPU']
                  return [`${value.toFixed(1)} %`, 'GPU']
                }}
              />
              <Legend wrapperStyle={{ fontSize: featured ? 11 : 10 }} />
              <Line type="monotone" dataKey="gpu" name="GPU%" stroke="#ff6b6b" dot={false} strokeWidth={featured ? 2 : 1.6} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {wrap(
          'GPU 显存 MB',
          <ResponsiveContainer width="100%" height={h}>
            <LineChart data={chartRows} margin={{ top: 6, right: 10, left: 4, bottom: showX ? 22 : 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              {xAxisShared}
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={axisFont} width={featured ? 42 : 36} domain={[0, 'auto']} />
              <Tooltip
                contentStyle={tip}
                labelFormatter={(ts) => formatTime(Number(ts))}
                formatter={(value: unknown) => {
                  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return ['—', '显存']
                  return [`${value.toFixed(1)} MB`, '显存']
                }}
              />
              <Legend wrapperStyle={{ fontSize: featured ? 11 : 10 }} />
              <Line type="monotone" dataKey="vram" name="显存" stroke="#9254de" dot={false} strokeWidth={featured ? 2 : 1.5} connectNulls isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>,
        )}
      </div>
    </div>
  )
}

export default ExternalPerfTrendCharts
