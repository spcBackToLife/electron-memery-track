import React, { useMemo, useState, useEffect } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import ProcessTable from './ProcessTable'
import V8HeapDetail from './V8HeapDetail'
import { listMarksWithSnapshots, type MarkWithSnapshot } from '../utils/marksWithSnapshots'
import type { MemorySnapshot } from '../../types/snapshot'

const COLORS = {
  browser: '#f5a623',
  renderer: '#61dafb',
  gpu: '#ff6b6b',
  other: '#8b8b8b',
}

const formatTime = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** 从快照拆出与趋势图一致的四类工作集 (MB) */
function breakdownMB(s: MemorySnapshot) {
  const browserMem = s.processes
    .filter((p) => p.type === 'Browser')
    .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
  const rendererMem = s.processes
    .filter((p) => p.type === 'Tab' && !p.isMonitorProcess)
    .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
  const gpuMem = s.processes
    .filter((p) => p.type === 'GPU')
    .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
  const otherMem = s.processes
    .filter((p) => !p.isMonitorProcess && p.type !== 'Browser' && p.type !== 'GPU' && p.type !== 'Tab')
    .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
  return {
    browser: Math.round((browserMem / 1024) * 10) / 10,
    renderer: Math.round((rendererMem / 1024) * 10) / 10,
    gpu: Math.round((gpuMem / 1024) * 10) / 10,
    other: Math.round((otherMem / 1024) * 10) / 10,
  }
}

export interface MarkBarRow {
  key: string
  axisLabel: string
  title: string
  mark: MarkWithSnapshot['mark']
  snapshot: MemorySnapshot
  browser: number
  renderer: number
  gpu: number
  other: number
}

function buildRows(items: MarkWithSnapshot[]): MarkBarRow[] {
  return items.map((item, i) => {
    const b = breakdownMB(item.snapshot)
    const labelShort = truncate(item.mark.label, 14)
    return {
      key: item.key,
      axisLabel: `#${i + 1} ${labelShort}`,
      title: `${formatTime(item.mark.timestamp)} · ${item.mark.label}`,
      mark: item.mark,
      snapshot: item.snapshot,
      ...b,
    }
  })
}

interface MarkMemoryExplorerProps {
  snapshots: MemorySnapshot[]
  /** 嵌入页标题微调 */
  variant?: 'dashboard' | 'report'
}

const MarkMemoryExplorer: React.FC<MarkMemoryExplorerProps> = ({ snapshots, variant = 'dashboard' }) => {
  const items = useMemo(() => listMarksWithSnapshots(snapshots), [snapshots])
  const rows = useMemo(() => buildRows(items), [items])

  const [selectedKey, setSelectedKey] = useState<string>('')

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedKey('')
      return
    }
    setSelectedKey((prev) => {
      if (prev && rows.some((r) => r.key === prev)) return prev
      return rows[0].key
    })
  }, [rows])

  const pickRowByBarIndex = (index: number) => {
    const r = rows[index]
    if (r) setSelectedKey(r.key)
  }

  const selected = useMemo(
    () => rows.find((r) => r.key === selectedKey) ?? null,
    [rows, selectedKey]
  )

  if (rows.length === 0) {
    return (
      <div className="mark-explorer mark-explorer-empty">
        <p className="mark-explorer-hint">
          {variant === 'dashboard'
            ? '暂无标记：在代码中调用 monitor.mark()，或使用上方「事件标记」在下一拍采样写入后，此处会出现各标记时刻的内存对比图。'
            : '当前加载的快照中无标记数据；若会话内曾打标，请确认未过度缩小时间范围。'}
        </p>
      </div>
    )
  }

  return (
    <div className="mark-explorer">
      <div className="mark-explorer-toolbar">
        <label className="mark-explorer-select-label">
          <span>选中标记</span>
          <select
            className="mark-explorer-select"
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
          >
            {rows.map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
        <span className="mark-explorer-caption">
          堆叠柱为各标记所在<strong>采样时刻</strong>的工作集（主进程 / 渲染 / GPU / 其他）。点击某一柱可切换下方详情。
        </span>
      </div>

      <div className="mark-explorer-chart-wrap">
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={rows}
            margin={{ top: 8, right: 16, left: 8, bottom: 48 }}
            barCategoryGap="18%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
            <XAxis
              dataKey="axisLabel"
              stroke="rgba(255,255,255,0.5)"
              fontSize={11}
              interval={0}
              angle={-28}
              textAnchor="end"
              height={70}
            />
            <YAxis
              stroke="rgba(255,255,255,0.5)"
              fontSize={12}
              tickFormatter={(v) => `${v} MB`}
              label={{ value: '工作集', angle: -90, position: 'insideLeft', fill: 'rgba(255,255,255,0.45)', fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(26, 26, 46, 0.96)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 8,
                color: '#e0e0e0',
              }}
              formatter={(value: number, name: string) => [`${value.toFixed(1)} MB`, name]}
              labelFormatter={(_, payload) => {
                const p = payload?.[0]?.payload as MarkBarRow | undefined
                return p ? p.title : ''
              }}
            />
            <Legend />
            <Bar
              stackId="mem"
              dataKey="browser"
              name="主进程"
              fill={COLORS.browser}
              onClick={(_d, index) => pickRowByBarIndex(index)}
              cursor="pointer"
            />
            <Bar
              stackId="mem"
              dataKey="renderer"
              name="渲染进程"
              fill={COLORS.renderer}
              onClick={(_d, index) => pickRowByBarIndex(index)}
              cursor="pointer"
            />
            <Bar
              stackId="mem"
              dataKey="gpu"
              name="GPU"
              fill={COLORS.gpu}
              onClick={(_d, index) => pickRowByBarIndex(index)}
              cursor="pointer"
            />
            <Bar
              stackId="mem"
              dataKey="other"
              name="其他"
              fill={COLORS.other}
              onClick={(_d, index) => pickRowByBarIndex(index)}
              cursor="pointer"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {selected && (
        <div className="mark-explorer-detail">
          <div className="mark-explorer-detail-head">
            <h4>
              📌 标记「{selected.mark.label}」时刻详情
            </h4>
            <p className="mark-explorer-detail-meta">
              采样时间 {formatTime(selected.snapshot.timestamp)}（seq #{selected.snapshot.seq}） · 进程 {selected.snapshot.processes.length} 个
              {selected.mark.metadata && Object.keys(selected.mark.metadata).length > 0 && (
                <span className="mark-explorer-meta-json"> · {JSON.stringify(selected.mark.metadata)}</span>
              )}
            </p>
          </div>

          <div className="section mark-explorer-process-section">
            <h3>📋 进程详情</h3>
            <ProcessTable processes={selected.snapshot.processes} />
          </div>

          {selected.snapshot.mainProcessV8Detail && (
            <div className="section mark-explorer-v8-section">
              <V8HeapDetail v8Detail={selected.snapshot.mainProcessV8Detail} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default MarkMemoryExplorer
