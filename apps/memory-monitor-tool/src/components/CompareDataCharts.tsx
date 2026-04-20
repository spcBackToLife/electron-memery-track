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
import type { CompareTrendPoint } from '../utils/comparePidMetrics'

export type { CompareTrendPoint }

interface CompareDataChartsProps {
  points: CompareTrendPoint[]
  baseLabel: string
  targetLabel: string
  /** 图表主标题，默认「内存曲线对比」 */
  title?: string
}

/**
 * 回归对比页：两次会话内存曲线（按采样序号对齐）
 */
const CompareDataCharts: React.FC<CompareDataChartsProps> = ({
  points,
  baseLabel,
  targetLabel,
  title = '📈 内存曲线对比',
}) => {
  const data = useMemo(() => points, [points])

  if (data.length < 2) return null

  return (
    <div className="mmt-history-charts compare-dual-chart">
      <h3>{title}</h3>
      <p className="chart-caption">
        横轴为对齐后的采样序号（两会话各取前 N 个采样点对齐，N = min(基线, 目标)）。按 PID
        对比时，缺采样点的进程记为 0 MB。
      </p>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 8, right: 28, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
          <XAxis dataKey="index" stroke="rgba(255,255,255,0.45)" fontSize={11} name="采样#" />
          <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} tickFormatter={(v) => `${v} MB`} />
          <Tooltip
            contentStyle={{
              background: 'rgba(26, 28, 38, 0.96)',
              border: '1px solid rgba(100,108,255,0.25)',
              borderRadius: 8,
              color: '#e0e0e0',
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
          />
          <Legend />
          <Line type="monotone" dataKey="baseMB" name={baseLabel} stroke="#1890ff" dot={false} strokeWidth={2} />
          <Line type="monotone" dataKey="targetMB" name={targetLabel} stroke="#fa8c16" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default CompareDataCharts
