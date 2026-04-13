import React from 'react'
import type { ProcessMemoryInfo } from '../../types/snapshot'

interface ProcessTableProps {
  processes: ProcessMemoryInfo[]
}

const formatKB = (kb: number): string => {
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

const getTypeColor = (type: string): string => {
  switch (type) {
    case 'Browser': return '#646cff'
    case 'Tab': return '#61dafb'
    case 'GPU': return '#f5a623'
    case 'Utility': return '#8b8b8b'
    default: return '#999'
  }
}

const getTypeName = (type: string): string => {
  switch (type) {
    case 'Browser': return '主进程'
    case 'Tab': return '渲染进程'
    case 'GPU': return 'GPU'
    case 'Utility': return '辅助进程'
    default: return type
  }
}

/** Chromium privateBytes（KiB），语义为专用提交而非专用工作集 */
const formatPrivate = (kb: number | undefined): string => {
  if (kb == null || Number.isNaN(kb)) return '—'
  return formatKB(kb)
}

const ProcessTable: React.FC<ProcessTableProps> = ({ processes }) => {
  const sorted = [...processes].sort((a, b) => b.memory.workingSetSize - a.memory.workingSetSize)

  // 检测是否有任何进程附带了 privateWorkingSet 数据（Windows 才有）
  const hasPrivateWs = sorted.some((p) => p.memory.privateWorkingSet != null)

  return (
    <div className="process-table-container">
      <p className="process-table-hint">
        {hasPrivateWs ? (
          <>
            <strong>专用工作集</strong>（绿色列）对应 Windows 任务管理器默认的「内存」列（WorkingSetPrivate），可直接按 PID 与任务管理器对照。
            <strong>工作集</strong>含共享 DLL 页面，通常 ≥ 专用工作集；<strong>专用提交</strong>是已提交的私有虚拟内存（含页面文件），可能 &gt; 工作集。
          </>
        ) : (
          <>
            <strong>无法与任务管理器默认列逐项完全一致：</strong>系统界面用的是微软自己的汇总/列定义（常见为<strong>专用工作集</strong>），而 Electron{' '}
            <code>getAppMetrics()</code> 只提供 Chromium 封装的两类数——<strong>工作集</strong>（驻留物理内存）与{' '}
            <strong>专用提交</strong>（<code>privateBytes</code>，接近 Windows 的专用已提交量 PrivateUsage）。二者与「专用工作集」不是同一个 Win32 计数器。
            已提交但未全在内存里时，<strong>专用提交可以大于工作集</strong>（截图里 GPU 即如此）。请按 <strong>PID</strong> 对照，并在任务管理器中通过「选择列」勾选<strong>工作集、专用工作集、提交大小</strong>逐列比对。
          </>
        )}
      </p>
      <table className="process-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>类型</th>
            <th>名称</th>
            {hasPrivateWs && (
              <th title="专用工作集 = 进程独占的已驻留物理 RAM（即任务管理器默认「内存」列）" className="memory-private-ws-header">
                专用工作集
              </th>
            )}
            <th title="含共享映射，通常 ≥ 专用工作集">工作集</th>
            <th>峰值</th>
            <th title="privateBytes ≈ 专用已提交（非 TM 默认的专用工作集）；可能大于工作集">专用提交</th>
            <th>CPU</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((proc) => (
            <tr key={proc.pid} className={proc.isMonitorProcess ? 'monitor-process' : ''}>
              <td className="pid">{proc.pid}</td>
              <td>
                <span
                  className="process-type-badge"
                  style={{ backgroundColor: getTypeColor(proc.type) }}
                >
                  {getTypeName(proc.type)}
                </span>
              </td>
              <td className="process-name">
                {proc.isMonitorProcess ? '🔍 ' : ''}
                {proc.name || proc.windowTitle || '-'}
              </td>
              {hasPrivateWs && (
                <td className="memory-value memory-private-ws">{formatPrivate(proc.memory.privateWorkingSet)}</td>
              )}
              <td className="memory-value">{formatKB(proc.memory.workingSetSize)}</td>
              <td className="memory-value">{formatKB(proc.memory.peakWorkingSetSize)}</td>
              <td className="memory-value memory-private">{formatPrivate(proc.memory.privateBytes)}</td>
              <td className="cpu-value">{proc.cpu.percentCPUUsage.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default ProcessTable
