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
import type { BatchMarkRef, BatchRunLoaded, BatchResourceMetric } from '../utils/batchMultiRunCharts'
import {
  buildBatchAggregateMemoryPoints,
  buildBatchProcessMemoryPoints,
  buildBatchResourcePoints,
  collectBatchMarkRefs,
  formatElapsedAxis,
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

const MARK_LABEL_FONT = 10
const MARK_LABEL_LINE = 11
/** 标签相对竖线向右偏移，避免与虚线叠在一起 */
const MARK_LABEL_X_OFFSET = 7
/** 相对绘图区顶部的起始下移 */
const MARK_LABEL_Y_OFFSET = 16

function StackedMarkLabel({ label, lineX, plotTop }: { label: string; lineX: number; plotTop: number }) {
  const chars = [...label]
  const textX = lineX + MARK_LABEL_X_OFFSET
  const startY = plotTop + MARK_LABEL_Y_OFFSET
  return (
    <text x={textX} y={startY} textAnchor="start" fill="#faad14" fontSize={MARK_LABEL_FONT}>
      {chars.map((ch, i) => (
        <tspan key={`${i}-${ch}`} x={textX} dy={i === 0 ? 0 : MARK_LABEL_LINE}>
          {ch}
        </tspan>
      ))}
    </text>
  )
}

function MultiRunChart({
  title,
  caption,
  points,
  series,
  unit,
  maxElapsedSec,
  marks,
  showMarks,
}: {
  title: string
  caption?: string
  points: Array<Record<string, number | string | null>>
  series: Array<{ key: string; label: string; color: string }>
  unit: string
  maxElapsedSec: number
  marks?: BatchMarkRef[]
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
          橙色竖线为阶段标记，标签在竖线右侧逐字竖排（字保持正向）；横轴为会话开始后经过秒数。
        </p>
      ) : null}
      <ResponsiveContainer width="100%" height={300} debounce={200}>
        <LineChart data={points} margin={{ top: 12, right: 28, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis
            type="number"
            dataKey="elapsedSec"
            scale="linear"
            stroke="rgba(255, 255, 255, 0.45)"
            fontSize={11}
            tickFormatter={formatElapsedAxis}
            domain={[0, maxElapsedSec]}
            allowDataOverflow
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
            labelFormatter={(sec) => `开始后 ${formatElapsedAxis(Number(sec))}`}
            formatter={(value: number, name: string) => [
              typeof value === 'number' ? `${value.toFixed(1)} ${unit}` : '—',
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {showMarks && markLines.map((m) => (
            <ReferenceLine
              key={`${m.sessionId}-${m.label}-${m.elapsedSec}`}
              x={m.elapsedSec}
              stroke="#faad14"
              strokeDasharray="4 3"
              strokeWidth={1.75}
              isFront
              ifOverflow="visible"
              label={({ viewBox }) => {
                if (!viewBox || typeof viewBox.x !== 'number') return null
                const plotTop = typeof viewBox.y === 'number' ? viewBox.y : 0
                return <StackedMarkLabel label={m.label} lineX={viewBox.x} plotTop={plotTop} />
              }}
            />
          ))}
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
        caption="横轴为会话开始后经过时间（秒），与各轮快照、mark 的 timestamp 同源；不同轮次可直接对比「第几秒发生了什么」。"
        points={memoryBundle.points}
        series={memoryBundle.series}
        unit="MB"
        maxElapsedSec={memoryBundle.maxElapsedSec}
        marks={marks}
        showMarks
      />

      {hasResource ? (
        <>
          <h3 className="batch-charts-section-title">🖥️ 资源性能（多轮叠加）</h3>
          <p className="chart-caption">
            CPU/磁盘为子树汇总；横轴同为会话内经过时间（秒）。
          </p>
          <div className="batch-resource-charts-grid">
            {resourceCharts.map((c) => (
              <MultiRunChart
                key={c.metric}
                title={c.meta.title}
                points={c.points}
                series={c.series}
                unit={c.meta.unit}
                maxElapsedSec={c.maxElapsedSec}
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
