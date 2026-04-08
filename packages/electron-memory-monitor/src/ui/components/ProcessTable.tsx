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

const ProcessTable: React.FC<ProcessTableProps> = ({ processes }) => {
  const sorted = [...processes].sort((a, b) => b.memory.workingSetSize - a.memory.workingSetSize)

  return (
    <div className="process-table-container">
      <table className="process-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>类型</th>
            <th>名称</th>
            <th>工作集</th>
            <th>峰值</th>
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
              <td className="memory-value">{formatKB(proc.memory.workingSetSize)}</td>
              <td className="memory-value">{formatKB(proc.memory.peakWorkingSetSize)}</td>
              <td className="cpu-value">{proc.cpu.percentCPUUsage.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default ProcessTable
