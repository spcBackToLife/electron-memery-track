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
import type { MemorySnapshot, EventMark } from '../../types/snapshot'

interface MemoryChartProps {
  snapshots: MemorySnapshot[]
  height?: number
}

const formatTime = (timestamp: number): string => {
  const d = new Date(timestamp)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

const formatKB = (kb: number): string => {
  if (kb > 1024) return `${(kb / 1024).toFixed(0)} MB`
  return `${Math.round(kb)} KB`
}

const COLORS = {
  total: '#646cff',
  browser: '#f5a623',
  renderer: '#61dafb',
  gpu: '#ff6b6b',
  other: '#8b8b8b',
}

const MemoryChart: React.FC<MemoryChartProps> = ({ snapshots, height = 300 }) => {
  const chartData = useMemo(() => {
    return snapshots.map((s) => {
      const browserMem = s.processes
        .filter((p) => p.type === 'Browser')
        .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
      const rendererMem = s.processes
        .filter((p) => p.type === 'Tab' && !p.isMonitorProcess)
        .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
      const gpuMem = s.processes
        .filter((p) => p.type === 'GPU')
        .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
      // 其他进程：Utility、Zygote 等（排除监控面板自身）
      const otherMem = s.processes
        .filter((p) => !p.isMonitorProcess && p.type !== 'Browser' && p.type !== 'GPU' && p.type !== 'Tab')
        .reduce((sum, p) => sum + p.memory.workingSetSize, 0)

      return {
        time: formatTime(s.timestamp),
        timestamp: s.timestamp,
        total: Math.round(s.totalWorkingSetSize / 1024 * 10) / 10,
        browser: Math.round(browserMem / 1024 * 10) / 10,
        renderer: Math.round(rendererMem / 1024 * 10) / 10,
        gpu: Math.round(gpuMem / 1024 * 10) / 10,
        other: Math.round(otherMem / 1024 * 10) / 10,
      }
    })
  }, [snapshots])

  // 收集所有事件标记
  const marks = useMemo(() => {
    const allMarks: EventMark[] = []
    for (const s of snapshots) {
      if (s.marks) allMarks.push(...s.marks)
    }
    return allMarks
  }, [snapshots])

  if (chartData.length === 0) {
    return <div className="chart-empty">等待数据采集...</div>
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
        <XAxis
          dataKey="time"
          stroke="rgba(255,255,255,0.5)"
          fontSize={12}
          interval="preserveStartEnd"
        />
        <YAxis
          stroke="rgba(255,255,255,0.5)"
          fontSize={12}
          tickFormatter={(v) => `${v} MB`}
        />
        <Tooltip
          contentStyle={{
            background: 'rgba(26, 26, 46, 0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            color: '#e0e0e0',
          }}
          formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
        />
        <Legend />
        <Line type="monotone" dataKey="total" name="总内存" stroke={COLORS.total} dot={false} strokeWidth={2} />
        <Line type="monotone" dataKey="browser" name="主进程" stroke={COLORS.browser} dot={false} strokeWidth={1.5} />
        <Line type="monotone" dataKey="renderer" name="渲染进程" stroke={COLORS.renderer} dot={false} strokeWidth={1.5} />
        <Line type="monotone" dataKey="gpu" name="GPU" stroke={COLORS.gpu} dot={false} strokeWidth={1.5} />
        <Line type="monotone" dataKey="other" name="其他" stroke={COLORS.other} dot={false} strokeWidth={1} strokeDasharray="4 2" />

        {marks.map((mark, idx) => (
          <ReferenceLine
            key={idx}
            x={formatTime(mark.timestamp)}
            stroke="#faad14"
            strokeDasharray="3 3"
            label={{ value: mark.label, position: 'top', fill: '#faad14', fontSize: 10 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export default MemoryChart
