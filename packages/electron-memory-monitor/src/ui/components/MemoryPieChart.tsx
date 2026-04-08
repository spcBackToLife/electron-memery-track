import React, { useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { ProcessMemoryInfo } from '../../types/snapshot'

interface MemoryPieChartProps {
  processes: ProcessMemoryInfo[]
  height?: number
}

// 使用更亮的颜色，在深色背景下有更好的对比度
const COLORS_MAP: Record<string, string> = {
  'Browser': '#7c83ff',
  'Tab': '#61dafb',
  'GPU': '#ffb347',
  'Utility': '#a8a8a8',
  'Zygote': '#ff8a8a',
}

const TYPE_NAMES: Record<string, string> = {
  'Browser': '主进程',
  'Tab': '渲染进程',
  'GPU': 'GPU',
  'Utility': '辅助进程',
  'Zygote': 'Zygote',
}

// 基于扇区角度中点计算标签位置，确保标签始终正确显示
const RADIAN = Math.PI / 180
const renderCustomLabel = ({
  cx,
  cy,
  midAngle,
  outerRadius,
  name,
  value,
  percent,
}: {
  cx: number
  cy: number
  midAngle: number
  outerRadius: number
  name: string
  value: number
  percent: number
}) => {
  const radius = outerRadius + 25
  const x = cx + radius * Math.cos(-midAngle * RADIAN)
  const y = cy + radius * Math.sin(-midAngle * RADIAN)

  return (
    <text
      x={x}
      y={y}
      fill="#e0e0e0"
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      fontSize={12}
    >
      {`${name} ${value}MB (${(percent * 100).toFixed(1)}%)`}
    </text>
  )
}

const MemoryPieChart: React.FC<MemoryPieChartProps> = ({ processes, height = 280 }) => {
  const data = useMemo(() => {
    const grouped = new Map<string, number>()
    for (const p of processes) {
      // 排除监控面板自身进程
      if (p.isMonitorProcess) continue
      const key = p.type
      grouped.set(key, (grouped.get(key) || 0) + p.memory.workingSetSize)
    }
    return Array.from(grouped.entries())
      .map(([type, value]) => ({
        name: TYPE_NAMES[type] || type,
        value: Math.round(value / 1024), // MB
        color: COLORS_MAP[type] || '#bbb',
      }))
      .sort((a, b) => b.value - a.value) // 按大小排序，大的扇区在前
  }, [processes])

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={28}
          label={renderCustomLabel}
          labelLine={{ stroke: 'rgba(255,255,255,0.4)', strokeWidth: 1 }}
          paddingAngle={2}
          isAnimationActive={false}
        >
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.color} stroke="rgba(0,0,0,0.3)" strokeWidth={1} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: 'rgba(26, 26, 46, 0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            color: '#e0e0e0',
          }}
          formatter={(value: number) => [`${value} MB`, '内存']}
        />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  )
}

export default MemoryPieChart
