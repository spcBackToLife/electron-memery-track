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
import type { MemorySnapshot } from '../types'
import { getEffectiveMemoryKB } from '../utils/format'

interface MemoryTrendChartProps {
  snapshots: MemorySnapshot[]
  height?: number
}

const formatTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

const COLORS = {
  total: '#646cff',
  browser: '#f5a623',
  renderer: '#61dafb',
  gpu: '#ff6b6b',
  other: '#8b8b8b',
}

/**
 * 内存趋势折线图 - 面向测试场景，关注整体趋势而非技术细节
 */
const MemoryTrendChart: React.FC<MemoryTrendChartProps> = ({ snapshots, height = 320 }) => {
  const hideElectronDetailLines = useMemo(
    () => snapshots.some((s) => s.monitorMode === 'external'),
    [snapshots],
  )

  const chartData = useMemo(() => {
    return snapshots.map((s) => {
      const ext = s.monitorMode === 'external'
      const browserMem = s.processes
        .filter((p) => p.type === 'Browser')
        .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
      const rendererMem = s.processes
        .filter((p) => p.type === 'Tab')
        .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
      const gpuMem = s.processes
        .filter((p) => p.type === 'GPU')
        .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)

      return {
        timestamp: s.timestamp,
        timeLabel: formatTime(s.timestamp),
        total: Math.round(s.totalWorkingSetSize / 1024 * 10) / 10,
        browser: ext ? 0 : Math.round(browserMem / 1024 * 10) / 10,
        renderer: ext ? 0 : Math.round(rendererMem / 1024 * 10) / 10,
        gpu: ext ? 0 : Math.round(gpuMem / 1024 * 10) / 10,
      }
    })
  }, [snapshots])

  if (chartData.length === 0) {
    return (
      <div className="mmt-chart-empty">
        <span>等待数据采集...</span>
      </div>
    )
  }

  const tMin = chartData[0]?.timestamp ?? 0
  const tMax = chartData[chartData.length - 1]?.timestamp ?? 0

  // 收集标记用于显示参考线
  const marks = useMemo(() => {
    const allMarks: Array<{ timestamp: number; label: string }> = []
    for (const s of snapshots) {
      if (s.marks) allMarks.push(...s.marks)
    }
    return allMarks
  }, [snapshots])

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis
          type="number"
          dataKey="timestamp"
          domain={[tMin, tMax]}
          stroke="rgba(255,255,255,0.45)"
          fontSize={11}
          tickFormatter={(ts: number) => formatTime(ts)}
        />
        <YAxis
          stroke="rgba(255,255,255,0.45)"
          fontSize={11}
          tickFormatter={(v) => `${v} MB`}
        />
        <Tooltip
          contentStyle={{
            background: 'rgba(26, 28, 38, 0.96)',
            border: '1px solid rgba(100,108,255,0.25)',
            borderRadius: 8,
            color: '#e0e0e0',
            fontSize: 12,
          }}
          labelFormatter={(ts) => formatTime(Number(ts))}
          formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="total"
          name={hideElectronDetailLines ? '进程树合计' : '总内存'}
          stroke={COLORS.total}
          dot={false}
          strokeWidth={2}
        />
        {!hideElectronDetailLines && (
          <>
            <Line type="monotone" dataKey="browser" name="主进程" stroke={COLORS.browser} dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="renderer" name="渲染进程" stroke={COLORS.renderer} dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="gpu" name="GPU" stroke={COLORS.gpu} dot={false} strokeWidth={1.5} />
          </>
        )}

        {/* 标记线 */}
        {marks.map((mark, idx) => (
          <line
            key={`${mark.timestamp}-${idx}`}
            x1={0}
            y1={0}
            x2={0}
            y2={0}
            stroke="#faad14"
            strokeDasharray="3 3"
          >
            {/* Recharts ReferenceLine 替代方案 - 使用自定义标记提示 */}
          </line>
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export default MemoryTrendChart
