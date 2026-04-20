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

/** 外部进程树：单图最多展示的进程条数（按会话内峰值内存排序），超出部分合并为「其余」 */
const EXTERNAL_TOP_PROCESS_LINES = 12

const PROCESS_LINE_PALETTE = [
  '#f5a623',
  '#61dafb',
  '#ff6b6b',
  '#52c41a',
  '#eb2f96',
  '#13c2c2',
  '#faad14',
  '#2f54eb',
  '#a0d911',
  '#9254de',
  '#ff7a45',
  '#36cfc9',
]

function legendLabelForPid(snapshots: MemorySnapshot[], pid: number): string {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const pr = snapshots[i].processes.find((x) => x.pid === pid)
    if (pr) {
      const base = (pr.name?.trim() || '进程').slice(0, 22)
      return `${base} (${pid})`
    }
  }
  return `PID ${pid}`
}

type ExternalSeriesMeta = {
  topPids: number[]
  hasOtherBucket: boolean
  otherPidCount: number
  legendByPid: Record<number, string>
}

/**
 * 内存趋势折线图
 * - 本工具（Electron）模式：总内存 + 主进程 / 渲染 / GPU
 * - 外部 exe 模式：进程树合计 + 各 PID 内存（峰值 Top N）+ 可选「其余进程」汇总
 */
const MemoryTrendChart: React.FC<MemoryTrendChartProps> = ({ snapshots, height = 320 }) => {
  const { hideElectronDetailLines, chartData, externalSeries } = useMemo(() => {
    const hideElectronDetailLines = snapshots.some((s) => s.monitorMode === 'external')

    if (!hideElectronDetailLines) {
      const chartData = snapshots.map((s) => {
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
          total: Math.round((s.totalWorkingSetSize / 1024) * 10) / 10,
          browser: Math.round((browserMem / 1024) * 10) / 10,
          renderer: Math.round((rendererMem / 1024) * 10) / 10,
          gpu: Math.round((gpuMem / 1024) * 10) / 10,
        }
      })
      return { hideElectronDetailLines, chartData, externalSeries: null as ExternalSeriesMeta | null }
    }

    const peakKbByPid = new Map<number, number>()
    for (const s of snapshots) {
      if (s.monitorMode !== 'external') continue
      for (const p of s.processes) {
        const kb = getEffectiveMemoryKB(p.memory)
        peakKbByPid.set(p.pid, Math.max(peakKbByPid.get(p.pid) ?? 0, kb))
      }
    }
    const sortedPids = [...peakKbByPid.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pid]) => pid)
    const topPids = sortedPids.slice(0, EXTERNAL_TOP_PROCESS_LINES)
    const tailPidSet = new Set(sortedPids.slice(EXTERNAL_TOP_PROCESS_LINES))

    const legendByPid: Record<number, string> = {}
    for (const pid of topPids) {
      legendByPid[pid] = legendLabelForPid(snapshots, pid)
    }

    const externalSeries: ExternalSeriesMeta = {
      topPids,
      hasOtherBucket: tailPidSet.size > 0,
      otherPidCount: tailPidSet.size,
      legendByPid,
    }

    const chartData = snapshots.map((s) => {
      const ext = s.monitorMode === 'external'
      const row: Record<string, number | string | null> = {
        timestamp: s.timestamp,
        timeLabel: formatTime(s.timestamp),
        total: Math.round((s.totalWorkingSetSize / 1024) * 10) / 10,
        browser: 0,
        renderer: 0,
        gpu: 0,
      }

      if (!ext) {
        return row
      }

      const byPid = new Map(s.processes.map((p) => [p.pid, p]))
      for (const pid of topPids) {
        const pr = byPid.get(pid)
        row[`p_${pid}`] = pr != null ? Math.round((getEffectiveMemoryKB(pr.memory) / 1024) * 10) / 10 : null
      }
      if (tailPidSet.size > 0) {
        let sumKb = 0
        for (const p of s.processes) {
          if (tailPidSet.has(p.pid)) sumKb += getEffectiveMemoryKB(p.memory)
        }
        row.externalOther = Math.round((sumKb / 1024) * 10) / 10
      }
      return row
    })

    return { hideElectronDetailLines, chartData, externalSeries }
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
          formatter={(value: unknown, name: string) => {
            if (value == null || typeof value !== 'number' || Number.isNaN(value)) {
              return ['—', name]
            }
            return [`${value.toFixed(1)} MB`, name]
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line
          type="monotone"
          dataKey="total"
          name={hideElectronDetailLines ? '进程树合计' : '总内存'}
          stroke={COLORS.total}
          dot={false}
          strokeWidth={2}
        />
        {hideElectronDetailLines && externalSeries
          ? (
              <>
                {externalSeries.topPids.map((pid, i) => (
                  <Line
                    key={pid}
                    type="monotone"
                    dataKey={`p_${pid}`}
                    name={externalSeries.legendByPid[pid] ?? `PID ${pid}`}
                    stroke={PROCESS_LINE_PALETTE[i % PROCESS_LINE_PALETTE.length]}
                    dot={false}
                    strokeWidth={1.35}
                    connectNulls={false}
                  />
                ))}
                {externalSeries.hasOtherBucket ? (
                  <Line
                    type="monotone"
                    dataKey="externalOther"
                    name={`其余 ${externalSeries.otherPidCount} 个进程（合计）`}
                    stroke={COLORS.other}
                    strokeDasharray="5 4"
                    dot={false}
                    strokeWidth={1.25}
                    connectNulls
                  />
                ) : null}
              </>
            )
          : (
              <>
                <Line type="monotone" dataKey="browser" name="主进程" stroke={COLORS.browser} dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="renderer" name="渲染进程" stroke={COLORS.renderer} dot={false} strokeWidth={1.5} />
                <Line type="monotone" dataKey="gpu" name="GPU" stroke={COLORS.gpu} dot={false} strokeWidth={1.5} />
              </>
            )}

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
  )
}

export default MemoryTrendChart
