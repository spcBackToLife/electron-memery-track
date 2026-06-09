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
import type { ReportEventMark, ReportSummary, MemorySnapshot } from '../types'
import { getEffectiveMemoryKB } from '../utils/format'
import ExternalPerfTrendCharts, { rowsFromReportDataPoints } from './ExternalPerfTrendCharts'

const formatAxisTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

interface ReportDataChartsProps {
  report: ReportSummary
  /** 与 report.eventMarks 一致；可传入从快照兜底的标记，便于旧报告 */
  eventMarks?: ReportEventMark[]
  /** 原始快照（用于按 PID 粒度展示进程级折线）；不传则回退到聚合 dataPoints */
  snapshots?: MemorySnapshot[]
}

/** 按 PID 峰值排序取 Top N 进程 */
const TOP_PROCESS_LINES = 12

const PROCESS_PALETTE = [
  '#f5a623', '#61dafb', '#ff6b6b', '#52c41a',
  '#eb2f96', '#13c2c2', '#faad14', '#2f54eb',
  '#a0d911', '#9254de', '#ff7a45', '#36cfc9',
]

/** 从最新快照生成图例标签（[角色] 进程名 + PID） */
function pidLabel(snaps: MemorySnapshot[], pid: number): string {
  const latest = snaps[snaps.length - 1]
  if (!latest) return `PID ${pid}`
  const proc = latest.processes.find((p) => p.pid === pid)
  if (proc) {
    const base = (proc.name?.trim() || '进程').slice(0, 16)
    const roleTag = getRoleTag(proc)
    return roleTag ? `${roleTag} ${base} (${pid})` : `${base} (${pid})`
  }
  return `PID ${pid}`
}

/** 根据 ProcessMemoryInfo 的 type/chromiumType 生成中文角色标签 */
function getRoleTag(proc: { type?: string; chromiumType?: string }): string {
  // 内部监控：type 字段
  switch (proc.type) {
    case 'Browser': return '[主进程]'
    case 'Tab': return '[渲染]'
    case 'GPU': return '[GPU]'
    case 'Utility': return '[辅助]'
  }
  // 外部监控：chromiumType 字段（--type=xxx）
  if (proc.chromiumType) {
    const t = proc.chromiumType.split(':')[0]?.toLowerCase() ?? ''
    if (t === 'browser') return '[主进程]'
    if (t === 'renderer') return '[渲染]'
    if (t === 'gpu-process') return '[GPU]'
    if (t === 'utility') return '[辅助]'
    if (t === 'crashpad-handler') return '[Crashpad]'
    // 其他如 zygote 等不常用，直接返回原始值
    return `[${t}]`
  }
  return ''
}

/**
 * 测试报告页内存趋势图：
 * - 有 snapshots 时 → 按每个子进程 PID 独立折线展示（便于定位持续增长的进程）
 * - 无 snapshots 时 → 回退到预聚合的 dataPoints（总内存 / 主进程 / 渲染 / GPU）
 */
const ReportDataCharts: React.FC<ReportDataChartsProps> = ({ report, eventMarks, snapshots }) => {
  const chartData = useMemo(() => report.dataPoints, [report.dataPoints])
  const marks = eventMarks ?? report.eventMarks ?? []
  const extPerfRows = useMemo(() => rowsFromReportDataPoints(chartData), [chartData])

  // ---- 按 PID 粒度计算折线数据（有快照时）----
  const perPidSeries = useMemo(() => {
    if (!snapshots || snapshots.length < 2) return null

    // 统计每个 PID 的峰值内存，取 Top N
    const peakKbByPid = new Map<number, number>()
    for (const s of snapshots) {
      for (const p of s.processes) {
        const kb = getEffectiveMemoryKB(p.memory)
        peakKbByPid.set(p.pid, Math.max(peakKbByPid.get(p.pid) ?? 0, kb))
      }
    }
    const sortedPids = [...peakKbByPid.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pid]) => pid)
    const topPids = sortedPids.slice(0, TOP_PROCESS_LINES)

    // 构建按时间采样的 per-PID 数据（降采样避免 Recharts 卡顿）
    const MAX_POINTS = 360
    const src = snapshots.length > MAX_POINTS
      ? snapshots.filter((_, i) => Math.floor(i * MAX_POINTS / snapshots.length) === Math.floor(i * MAX_POINTS / snapshots.length - 0.01)) || [snapshots[0], snapshots[snapshots.length - 1]]
      : snapshots

    const rows = src.map((s) => {
      const row: Record<string, number | string | null> = {
        timestamp: s.timestamp,
        timeLabel: formatAxisTime(s.timestamp),
        totalMB: Math.round((s.totalWorkingSetSize / 1024) * 10) / 10,
        totalPrivateBytesMB: Math.round(((s.totalPrivateBytes ?? 0) / 1024) * 10) / 10,
      }
      // 每个 Top PID 一列
      const pidMap = new Map(s.processes.map((p) => [p.pid, p]))
      for (const pid of topPids) {
        const proc = pidMap.get(pid)
        row[`p_${pid}`] = proc != null
          ? Math.round((getEffectiveMemoryKB(proc.memory) / 1024) * 10) / 10
          : null
      }
      return row
    })

    return { topPids, data: rows }
  }, [snapshots])

  if (chartData.length < 2) return null

  const t0 = chartData[0].timestamp
  const t1 = chartData[chartData.length - 1].timestamp

  // 有 perPid 数据时用 PID 粒度渲染，否则回退聚合模式
  const usePerPid = perPidSeries != null && perPidSeries.data.length >= 2
  const displayData = usePerPid ? perPidSeries.data : chartData

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
        {usePerPid
          ? '按子进程 PID 独立展示内存折线（按峰值排序 Top 12），便于定位持续增长的进程。'
          : '基于会话内采样点绘制，与实时监控页指标口径一致。'}
        {marks.length > 0 ? ' 橙色竖线为事件标记时刻（与下方「阶段标记」表对应）。' : ''}
      </p>
      <ResponsiveContainer width="100%" height={320} debounce={200}>
        <LineChart data={displayData} margin={{ top: 8, right: 28, left: 8, bottom: 8 }}>
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
            formatter={(value: unknown, name: string) => {
              if (value == null || typeof value !== 'number' || Number.isNaN(value)) return ['—', name]
              return [`${Number(value).toFixed(1)} MB`, name]
            }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />

          {usePerPid && perPidSeries ? (
            <>
              {/* 总内存参考线 */}
              <Line
                type="monotone"
                dataKey="totalMB"
                name="总内存"
                stroke="#646cff"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="totalPrivateBytesMB"
                name="专用提交合计"
                stroke="#b37feb"
                dot={false}
                strokeWidth={1.75}
                strokeDasharray="6 4"
                isAnimationActive={false}
              />
              {/* 每个 Top PID 一条独立线 */}
              {perPidSeries.topPids.map((pid, i) => (
                <Line
                  key={pid}
                  type="monotone"
                  dataKey={`p_${pid}`}
                  name={pidLabel(snapshots!, pid)}
                  stroke={PROCESS_PALETTE[i % PROCESS_PALETTE.length]}
                  dot={false}
                  strokeWidth={1.35}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </>
          ) : (
            <>
              <Line type="monotone" dataKey="totalMB" name="总内存" stroke="#646cff" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="totalPrivateBytesMB" name="专用提交合计" stroke="#b37feb" dot={false} strokeWidth={1.75} strokeDasharray="6 4" isAnimationActive={false} />
              <Line type="monotone" dataKey="browserMB" name="主进程" stroke="#f5a623" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              <Line type="monotone" dataKey="rendererMB" name="渲染/子进程" stroke="#61dafb" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              <Line type="monotone" dataKey="gpuMB" name="GPU" stroke="#ff6b6b" dot={false} strokeWidth={1.5} isAnimationActive={false} />
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
    </div>
  )
}

export default ReportDataCharts
