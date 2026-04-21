import React from 'react'
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
import type { CompareResourcePoint } from '../utils/comparePidMetrics'
import type { CompareChartMarkRef } from './CompareDataCharts'

const tip = {
  background: 'rgba(26, 28, 38, 0.96)',
  border: '1px solid rgba(100,108,255,0.25)',
  borderRadius: 8,
  color: '#e0e0e0',
  fontSize: 12,
}

interface CompareResourceTrendChartsProps {
  points: CompareResourcePoint[]
  baseLabel: string
  targetLabel: string
  markRefs?: CompareChartMarkRef[]
}

function MarkLines({ markRefs }: { markRefs?: CompareChartMarkRef[] }) {
  if (!markRefs?.length) return null
  return (
    <>
      {markRefs.map((m, i) => (
        <ReferenceLine
          key={`${m.side}-${m.index}-${m.label}-${i}`}
          x={m.index}
          stroke={m.side === 'base' ? 'rgba(24, 144, 255, 0.85)' : 'rgba(250, 140, 22, 0.9)'}
          strokeDasharray="4 3"
          strokeWidth={1.1}
          label={{
            value: `${m.side === 'base' ? '基线' : '目标'} · ${m.label}`,
            position: 'insideTop',
            fill: m.side === 'base' ? '#69b1ff' : '#ffc069',
            fontSize: 8,
          }}
        />
      ))}
    </>
  )
}

/**
 * 两次会话外部资源曲线：横轴为采样序号对齐（与内存对比图一致）
 */
const CompareResourceTrendCharts: React.FC<CompareResourceTrendChartsProps> = ({
  points,
  baseLabel,
  targetLabel,
  markRefs,
}) => {
  if (points.length < 2) return null

  const h = 200
  const shortBase = baseLabel.length > 28 ? `${baseLabel.slice(0, 26)}…` : baseLabel
  const shortTarget = targetLabel.length > 28 ? `${targetLabel.slice(0, 26)}…` : targetLabel

  const cell = (title: string, children: React.ReactNode) => (
    <div className="compare-resource-cell">
      <span className="compare-resource-cell-label">{title}</span>
      {children}
    </div>
  )

  return (
    <div className="mmt-history-charts compare-resource-charts">
      <h3>🖥️ 资源曲线对比（CPU · 磁盘 · GPU）</h3>
      <p className="chart-caption">
        与内存对比相同：<strong>采样序号对齐</strong>（第 N 次对第 N 次）。CPU、磁盘为各会话<strong>子树汇总</strong>；GPU、显存为各会话<strong>子树 PID 过滤</strong>后的 PDH 汇总。首拍 CPU/磁盘可能为 0。
      </p>
      <div className="compare-resource-grid">
        {cell(
          'CPU 合计 %',
          <ResponsiveContainer width="100%" height={h} debounce={200}>
            <LineChart data={points} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="index" stroke="rgba(255,255,255,0.45)" fontSize={11} name="采样#" />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={40} />
              <Tooltip contentStyle={tip} formatter={(v: number, name: string) => [`${v.toFixed(1)} %`, name]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="baseCpu" name={shortBase} stroke="#1890ff" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Line type="monotone" dataKey="targetCpu" name={shortTarget} stroke="#fa8c16" dot={false} strokeWidth={2} isAnimationActive={false} />
              <MarkLines markRefs={markRefs} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {cell(
          '磁盘 KB/s（读 / 写）',
          <ResponsiveContainer width="100%" height={h} debounce={200}>
            <LineChart data={points} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="index" stroke="rgba(255,255,255,0.45)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={40} />
              <Tooltip contentStyle={tip} formatter={(v: number, n: string) => [`${v.toFixed(1)} KB/s`, n]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Line type="monotone" dataKey="baseDiskRead" name={`${shortBase}·读`} stroke="#69b1ff" dot={false} strokeWidth={1.6} isAnimationActive={false} />
              <Line type="monotone" dataKey="targetDiskRead" name={`${shortTarget}·读`} stroke="#ffc069" dot={false} strokeWidth={1.6} isAnimationActive={false} />
              <Line type="monotone" dataKey="baseDiskWrite" name={`${shortBase}·写`} stroke="#096dd9" dot={false} strokeDasharray="4 2" strokeWidth={1.4} isAnimationActive={false} />
              <Line type="monotone" dataKey="targetDiskWrite" name={`${shortTarget}·写`} stroke="#d46b08" dot={false} strokeDasharray="4 2" strokeWidth={1.4} isAnimationActive={false} />
              <MarkLines markRefs={markRefs} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {cell(
          'GPU 总使用率 %',
          <ResponsiveContainer width="100%" height={h} debounce={200}>
            <LineChart data={points} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="index" stroke="rgba(255,255,255,0.45)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={40} domain={[0, 'auto']} />
              <Tooltip
                contentStyle={tip}
                formatter={(value: unknown, name: string) => {
                  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return ['—', name]
                  return [`${value.toFixed(1)} %`, name]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="baseGpu" name={shortBase} stroke="#1890ff" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
              <Line type="monotone" dataKey="targetGpu" name={shortTarget} stroke="#fa8c16" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
              <MarkLines markRefs={markRefs} />
            </LineChart>
          </ResponsiveContainer>,
        )}
        {cell(
          'GPU 显存 MB',
          <ResponsiveContainer width="100%" height={h} debounce={200}>
            <LineChart data={points} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="index" stroke="rgba(255,255,255,0.45)" fontSize={11} />
              <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={40} domain={[0, 'auto']} />
              <Tooltip
                contentStyle={tip}
                formatter={(value: unknown, name: string) => {
                  if (value == null || typeof value !== 'number' || Number.isNaN(value)) return ['—', name]
                  return [`${value.toFixed(1)} MB`, name]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="baseVram" name={shortBase} stroke="#9254de" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
              <Line type="monotone" dataKey="targetVram" name={shortTarget} stroke="#eb2f96" dot={false} strokeWidth={2} connectNulls isAnimationActive={false} />
              <MarkLines markRefs={markRefs} />
            </LineChart>
          </ResponsiveContainer>,
        )}
      </div>
    </div>
  )
}

export default CompareResourceTrendCharts
