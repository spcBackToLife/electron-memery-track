import React, { useMemo } from 'react'
import { PieChart, Pie, Cell, Tooltip, Legend } from 'recharts'
import { useChartContainerWidth } from '../hooks/useChartContainerWidth'
import type { ProcessMemoryInfo } from '../types'
import { getEffectiveMemoryKB } from '../utils/format'

interface MemoryDistributionPieProps {
  processes: ProcessMemoryInfo[]
  height?: number
  externalMonitor?: boolean
  /** 外部模式：仅这些 PID 参与占比（与进程树合计一致）；不传则使用全部进程 */
  externalTotalIncludedPids?: number[]
}

const COLORS_MAP: Record<string, string> = {
  Browser: '#7c83ff',
  Tab: '#61dafb',
  GPU: '#ffb347',
  Utility: '#a8a8a8',
  Zygote: '#ff8a8a',
}

const TYPE_NAMES_SELF: Record<string, string> = {
  Browser: '主进程',
  Tab: '渲染进程',
  GPU: 'GPU',
  Utility: '辅助进程',
  Zygote: 'Zygote',
}

const TYPE_NAMES_EXTERNAL: Record<string, string> = {
  Browser: '主进程',
  Tab: '子进程',
  GPU: 'GPU',
  Utility: '辅助进程',
  Zygote: 'Zygote',
}

/**
 * 内存分布饼图 - 简洁展示各进程类型内存占比（测试视角）
 */
const MemoryDistributionPie: React.FC<MemoryDistributionPieProps> = ({
  processes,
  height = 280,
  externalMonitor = false,
  externalTotalIncludedPids,
}) => {
  const [boxRef, w] = useChartContainerWidth()
  const chartW = w > 40 ? w : 260

  const data = useMemo(() => {
    const names = externalMonitor ? TYPE_NAMES_EXTERNAL : TYPE_NAMES_SELF
    const included =
      externalMonitor && Array.isArray(externalTotalIncludedPids)
        ? new Set(externalTotalIncludedPids)
        : null
    const list = included ? processes.filter((p) => included.has(p.pid)) : processes
    const grouped = new Map<string, number>()
    for (const p of list) {
      const key = p.type
      grouped.set(key, (grouped.get(key) || 0) + getEffectiveMemoryKB(p.memory))
    }
    return Array.from(grouped.entries())
      .map(([type, value]) => ({
        name: names[type] || type,
        value: Math.round(value / 1024),
        color: COLORS_MAP[type] || '#bbb',
      }))
      .sort((a, b) => b.value - a.value)
  }, [processes, externalMonitor, externalTotalIncludedPids])

  return (
    <div ref={boxRef as React.Ref<HTMLDivElement>} className="mmt-chart-size-box" style={{ width: '100%', height }}>
      <PieChart width={chartW} height={height}>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={32}
          paddingAngle={2}
          isAnimationActive={false}
          label={({ name, value, percent }) =>
            `${name} ${value}MB (${(percent * 100).toFixed(1)}%)`
          }
        >
          {data.map((entry, index) => (
            <Cell key={index} fill={entry.color} stroke="rgba(0,0,0,0.25)" strokeWidth={1} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: 'rgba(26, 28, 38, 0.95)',
            border: '1px solid rgba(100,108,255,0.25)',
            borderRadius: 8,
            color: '#e0e0e0',
          }}
          formatter={(value: number) => [`${value} MB`, '内存占用']}
        />
        <Legend />
      </PieChart>
    </div>
  )
}

export default MemoryDistributionPie
