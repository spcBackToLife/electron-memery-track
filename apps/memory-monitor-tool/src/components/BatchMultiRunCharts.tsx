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
  ReferenceLine,
} from 'recharts'
import type { ComparePidSelection } from '../utils/comparePidMetrics'
import type { BatchMarkAtPct, BatchRunLoaded, BatchResourceMetric } from '../utils/batchMultiRunCharts'
import {
  buildBatchAggregateMemoryPoints,
  buildBatchProcessMemoryPoints,
  buildBatchResourcePoints,
  collectBatchMarkRefs,
  hasBatchResourceData,
} from '../utils/batchMultiRunCharts'

interface BatchMultiRunChartsProps {
  runs: BatchRunLoaded[]
  processSelection: ComparePidSelection
}

const RESOURCE_TITLES: Record<BatchResourceMetric, { title: string; unit: string }> = {
  cpu: { title: 'CPU 合计 %', unit: '%' },
  diskRead: { title: '磁盘读取 KB/s', unit: 'KB/s' },
  diskWrite: { title: '磁盘写入 KB/s', unit: 'KB/s' },
  gpu: { title: 'GPU 引擎 %', unit: '%' },
  vram: { title: 'GPU 显存 MB', unit: 'MB' },
}

function MultiRunChart({
  title,
  caption,
  points,
  series,
  unit,
  marks,
  showMarks,
}: {
  title: string
  caption?: string
  points: Array<Record<string, number | string | null>>
  series: Array<{ key: string; label: string; color: string }>
  unit: string
  marks?: BatchMarkAtPct[]
  showMarks?: boolean
}) {
  if (points.length < 2 || series.length === 0) return null

  const markLines = marks ?? []

  return (
    <div className="batch-multi-chart">
      <h4>{title}</h4>
      {caption ? <p className="chart-caption">{caption}</p> : null}
      {showMarks && markLines.length > 0 ? (
        <p className="chart-caption batch-mark-chart-hint">
          橙色竖线为阶段标记（与单次测试报告一致，按各会话进度 % 落在折线图内）。
        </p>
      ) : null}
      <ResponsiveContainer width="100%" height={300} debounce={200}>
        <LineChart data={points} margin={{ top: 32, right: 28, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis
            dataKey="pct"
            stroke="rgba(255,255,255,0.45)"
            fontSize={11}
            tickFormatter={(v) => `${v}%`}
            domain={[0, 100]}
          />
          <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} />
          <Tooltip
            contentStyle={{
              background: 'rgba(26, 28, 38, 0.96)',
              border: '1px solid rgba(100,108,255,0.25)',
              borderRadius: 8,
              color: '#e0e0e0',
              fontSize: 12,
            }}
            labelFormatter={(pct) => `进度 ${pct}%`}
            formatter={(value: number, name: string) => [
              typeof value === 'number' ? `${value.toFixed(1)} ${unit}` : '—',
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              dot={false}
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
          {showMarks && markLines.map((m, idx) => {
            const labelPos = idx % 3 === 0 ? 'insideTopLeft' : idx % 3 === 1 ? 'insideTop' : 'insideTopRight'
            return (
              <ReferenceLine
                key={`${m.sessionId}-${m.label}-${m.pct}-${idx}`}
                x={m.pct}
                stroke="#faad14"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                label={{
                  value: m.label,
                  position: labelPos,
                  fill: '#faad14',
                  fontSize: 10,
                }}
              />
            )
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

const BatchMultiRunCharts: React.FC<BatchMultiRunChartsProps> = ({ runs, processSelection }) => {
  const memoryBundle = useMemo(() => {
    if (processSelection === 'aggregate') {
      return buildBatchAggregateMemoryPoints(runs)
    }
    return buildBatchProcessMemoryPoints(runs, processSelection)
  }, [runs, processSelection])

  const marks = useMemo(() => collectBatchMarkRefs(runs), [runs])
  const hasResource = useMemo(() => hasBatchResourceData(runs), [runs])

  const resourceCharts = useMemo(() => {
    if (!hasResource) return []
    const metrics: BatchResourceMetric[] = ['cpu', 'diskRead', 'diskWrite', 'gpu', 'vram']
    return metrics
      .map((m) => ({ metric: m, ...buildBatchResourcePoints(runs, m), meta: RESOURCE_TITLES[m] }))
      .filter((c) => c.points.length >= 2)
  }, [runs, hasResource])

  if (runs.length < 2) {
    return <p className="chart-caption">至少需要 2 轮有效数据才能绘制对比折线。</p>
  }

  return (
    <div className="batch-charts-wrap">
      <MultiRunChart
        title={processSelection === 'aggregate' ? '📈 总内存趋势（多轮叠加）' : '📈 进程内存趋势（多轮叠加）'}
        caption="横轴为各轮会话进度 0–100%（按时长归一化），便于不同长度轮次对齐比较。同色线 = 同一轮测试；橙色竖线为场景 mark。"
        points={memoryBundle.points}
        series={memoryBundle.series}
        unit="MB"
        marks={marks}
        showMarks
      />

      {hasResource ? (
        <>
          <h3 className="batch-charts-section-title">🖥️ 资源性能（多轮叠加）</h3>
          <p className="chart-caption">
            CPU/磁盘为子树汇总；GPU 引擎 % 与显存 MB 分开展示。数据来自各轮 report.dataPoints 的 ext* 字段。
          </p>
          <div className="batch-resource-charts-grid">
            {resourceCharts.map((c) => (
              <MultiRunChart
                key={c.metric}
                title={c.meta.title}
                points={c.points}
                series={c.series}
                unit={c.meta.unit}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="chart-caption">本轮批次无外部资源序列（ext* 字段），仅展示内存对比图。</p>
      )}
    </div>
  )
}

export default BatchMultiRunCharts
