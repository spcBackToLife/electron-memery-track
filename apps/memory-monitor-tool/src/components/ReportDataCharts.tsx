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

  if (chartData.length < 2) return null

  const t0 = chartData[0].timestamp
  const t1 = chartData[chartData.length - 1].timestamp

  return (
    <div className="mmt-history-charts">
      <h3>📈 内存趋势（本会话）</h3>
      <p className="chart-caption">
        基于会话内采样点绘制，与实时监控页指标口径一致。
        {marks.length > 0 ? ' 橙色竖线为事件标记时刻（与下方「阶段标记」表对应）。' : ''}
      </p>
      <ResponsiveContainer width="100%" height={320}>
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
          <Line type="monotone" dataKey="totalMB" name="总内存" stroke="#646cff" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="browserMB" name="主进程" stroke="#f5a623" dot={false} strokeWidth={1.5} />
          <Line type="monotone" dataKey="rendererMB" name="渲染/子进程" stroke="#61dafb" dot={false} strokeWidth={1.5} />
          <Line type="monotone" dataKey="gpuMB" name="GPU" stroke="#ff6b6b" dot={false} strokeWidth={1.5} />
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
