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
import type { ReportEventMark, ReportSummary } from '../types'
import ExternalPerfTrendCharts, { rowsFromReportDataPoints } from './ExternalPerfTrendCharts'

const formatAxisTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

interface ReportDataChartsProps {
  report: ReportSummary
  /** 与 report.eventMarks 一致；可传入从快照兜底的标记，便于旧报告 */
  eventMarks?: ReportEventMark[]
}

/**
 * 测试报告页：根据 dataPoints 还原总内存 / 主进程 / 渲染 / GPU 趋势
 */
const ReportDataCharts: React.FC<ReportDataChartsProps> = ({ report, eventMarks }) => {
  const chartData = useMemo(() => report.dataPoints, [report.dataPoints])
  const marks = eventMarks ?? report.eventMarks ?? []
  const extPerfRows = useMemo(() => rowsFromReportDataPoints(chartData), [chartData])

  if (chartData.length < 2) return null

  const t0 = chartData[0].timestamp
  const t1 = chartData[chartData.length - 1].timestamp

  return (
    <div className="mmt-history-charts">
      {extPerfRows.length >= 2 ? (
        <>
          <h3>🖥️ 资源性能（CPU · 磁盘 · GPU）</h3>
          <p className="chart-caption">
            来自报告采样中的外部进程树汇总字段；与实时监控页资源区口径一致。
          </p>
          <ExternalPerfTrendCharts rows={extPerfRows} layout="featured" />
        </>
      ) : (
        <p className="chart-caption">
          本会话未写入外部进程树资源序列（自监控会话或旧版报告无 ext 字段），下方仅展示内存趋势。
        </p>
      )}

      <h3>📈 内存趋势（本会话）</h3>
      <p className="chart-caption">
        基于会话内采样点绘制，与实时监控页指标口径一致。
        {marks.length > 0 ? ' 橙色竖线为事件标记时刻（与下方「阶段标记」表对应）。' : ''}
      </p>
      <ResponsiveContainer width="100%" height={320} debounce={200}>
        <LineChart data={chartData} margin={{ top: 8, right: 28, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis
            type="number"
            dataKey="timestamp"
            domain={[t0, t1]}
            stroke="rgba(255,255,255,0.45)"
            fontSize={11}
            tickFormatter={(ts: number) => formatAxisTime(ts)}
          />
          <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} tickFormatter={(v) => `${v} MB`} />
          <Tooltip
            contentStyle={{
              background: 'rgba(26, 28, 38, 0.96)',
              border: '1px solid rgba(100,108,255,0.25)',
              borderRadius: 8,
              color: '#e0e0e0',
              fontSize: 12,
            }}
            labelFormatter={(ts) => formatAxisTime(Number(ts))}
            formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
          />
          <Legend />
          <Line type="monotone" dataKey="totalMB" name="总内存" stroke="#646cff" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line type="monotone" dataKey="browserMB" name="主进程" stroke="#f5a623" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          <Line type="monotone" dataKey="rendererMB" name="渲染/子进程" stroke="#61dafb" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          <Line type="monotone" dataKey="gpuMB" name="GPU" stroke="#ff6b6b" dot={false} strokeWidth={1.5} isAnimationActive={false} />
          {marks.map((mark, idx) => (
            <ReferenceLine
              key={`${mark.timestamp}-${idx}-${mark.label}`}
              x={mark.timestamp}
              stroke="#faad14"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: mark.label, position: 'top', fill: '#faad14', fontSize: 10 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default ReportDataCharts
