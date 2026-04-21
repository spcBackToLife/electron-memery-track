import React, { useMemo } from 'react'
import type { ProcessMemoryInfo } from '../types'
import { getEffectiveMemoryKB } from '../utils/format'

interface ProcessTableProps {
  processes: ProcessMemoryInfo[]
  externalMonitor?: boolean
  /** 外部模式：参与「进程树合计」的 PID；未传则视为全部计入 */
  externalTotalIncludedPids?: number[]
  /** 取消勾选 = 从合计中排除（excluded=true） */
  onTogglePidInTotal?: (pid: number, excluded: boolean) => void
}

const formatKB = (kb: number): string => {
  if (kb > 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB`
  if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB`
  return `${Math.round(kb)} KB`
}

const getTypeName = (type: string, external: boolean): string => {
  if (external) {
    switch (type) {
      case 'Browser': return '主进程'
      case 'Tab': return '子进程'
      case 'GPU': return 'GPU'
      case 'Utility': return '辅助进程'
      default: return type
    }
  }
  switch (type) {
    case 'Browser': return '主进程'
    case 'Tab': return '渲染进程'
    case 'GPU': return 'GPU'
    case 'Utility': return '辅助进程'
    default: return type
  }
}

const getTypeColor = (type: string): string => {
  switch (type) {
    case 'Browser': return '#646cff'
    case 'Tab': return '#61dafb'
    case 'GPU': return '#f5a623'
    default: return '#999'
  }
}

/** Chromium --type= 简短中文，与任务管理器命令行一致 */
const chromiumTypeLabel = (raw: string): string => {
  const t = raw.split(':')[0]?.toLowerCase() ?? raw.toLowerCase()
  if (t === 'gpu-process') return 'GPU'
  if (t === 'renderer') return '渲染'
  if (t === 'browser') return '浏览器'
  if (t === 'utility') return 'Utility'
  if (t === 'crashpad-handler') return 'Crashpad'
  if (t === 'zygote') return 'Zygote'
  return raw.length > 20 ? `${raw.slice(0, 18)}…` : raw
}

const chromiumTypeBadgeColor = (raw: string): string => {
  const t = raw.split(':')[0]?.toLowerCase() ?? ''
  if (t === 'gpu-process') return getTypeColor('GPU')
  if (t === 'renderer') return getTypeColor('Tab')
  if (t === 'browser') return getTypeColor('Browser')
  if (t === 'utility') return '#8b6ec8'
  if (t === 'crashpad-handler') return '#5c5c5c'
  if (t === 'zygote') return '#4a7a8f'
  return '#888'
}

/** 外部监控：徽章直接展示 Chromium 角色；完整命令行放在 title */
const externalTypeBadge = (
  proc: ProcessMemoryInfo,
): { label: string; color: string; title?: string } => {
  if (proc.type === 'Browser') {
    return { label: '主进程', color: getTypeColor('Browser'), title: proc.chromiumType }
  }
  if (proc.chromiumType) {
    return {
      label: chromiumTypeLabel(proc.chromiumType),
      color: chromiumTypeBadgeColor(proc.chromiumType),
      title: proc.chromiumType,
    }
  }
  if (proc.type === 'GPU') {
    return { label: 'GPU', color: getTypeColor('GPU') }
  }
  if (proc.type === 'Utility') {
    return { label: '辅助进程', color: '#8b6ec8' }
  }
  if (proc.type === 'Zygote') {
    return { label: 'Zygote', color: chromiumTypeBadgeColor('zygote') }
  }
  return { label: '子进程', color: getTypeColor('Tab') }
}

/**
 * 进程表格 - 简化版，去掉 V8 相关列，只关注进程级内存
 */
const ProcessTable: React.FC<ProcessTableProps> = ({
  processes,
  externalMonitor = false,
  externalTotalIncludedPids,
  onTogglePidInTotal,
}) => {
  const sorted = useMemo(
    () => [...processes].sort((a, b) => getEffectiveMemoryKB(b.memory) - getEffectiveMemoryKB(a.memory)),
    [processes],
  )

  const includedSet = useMemo(() => {
    if (!externalMonitor || !externalTotalIncludedPids) {
      return null as Set<number> | null
    }
    return new Set(externalTotalIncludedPids)
  }, [externalMonitor, externalTotalIncludedPids])

  const showTotalColumn = Boolean(externalMonitor && onTogglePidInTotal && includedSet)

  return (
    <div className="mmt-process-table-container">
      <table className="mmt-process-table">
        <thead>
          <tr>
            {showTotalColumn ? (
              <th title="未勾选的进程仍显示内存，但不计入上方「进程树合计」">计入合计</th>
            ) : null}
            <th>PID</th>
            <th title={externalMonitor ? '主进程为树根；其余为子进程。能读到命令行时徽章显示 --type= 角色（悬停可看原始片段）' : undefined}>
              类型
            </th>
            <th>{externalMonitor ? '进程名' : '名称'}</th>
            <th title="优先专用工作集（系统 API / Native），未就绪时回退工作集">内存</th>
            <th title="Electron 上报的峰值工作集">峰值</th>
            <th>CPU</th>
            {externalMonitor ? (
              <>
                <th title="相对上一拍采样间隔的读速率">读 KB/s</th>
                <th title="相对上一拍采样间隔的写速率">写 KB/s</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {sorted.map((proc) => {
            const inTotal = !includedSet || includedSet.has(proc.pid)
            const typeBadge: { label: string; color: string; title?: string } = externalMonitor
              ? externalTypeBadge(proc)
              : { label: getTypeName(proc.type, false), color: getTypeColor(proc.type) }
            return (
              <tr
                key={proc.pid}
                className={['mmt-process-table-row', showTotalColumn && !inTotal ? 'row-excluded-from-total' : '']
                  .filter(Boolean)
                  .join(' ')}
              >
                {showTotalColumn ? (
                  <td className="mmt-col-include-total">
                    <input
                      type="checkbox"
                      checked={inTotal}
                      title={inTotal ? '取消勾选则从进程树合计中排除' : '勾选则重新计入进程树合计'}
                      onChange={(e) => {
                        e.stopPropagation()
                        onTogglePidInTotal!(proc.pid, !e.target.checked)
                      }}
                    />
                  </td>
                ) : null}
                <td>{proc.pid}</td>
                <td className="mmt-type-cell">
                  <span
                    className="mmt-type-badge"
                    style={{ backgroundColor: typeBadge.color }}
                    title={typeBadge.title}
                  >
                    {typeBadge.label}
                  </span>
                </td>
                <td className="proc-name">{proc.name || (externalMonitor ? `PID ${proc.pid}` : '-')}</td>
                <td className="mem-value">{formatKB(getEffectiveMemoryKB(proc.memory))}</td>
                <td className="mem-value">{formatKB(proc.memory.peakWorkingSetSize)}</td>
                <td className="cpu-value">{proc.cpu.percentCPUUsage.toFixed(1)}%</td>
                {externalMonitor ? (
                  <>
                    <td className="cpu-value">{(proc.diskReadKBps ?? 0).toFixed(1)}</td>
                    <td className="cpu-value">{(proc.diskWriteKBps ?? 0).toFixed(1)}</td>
                  </>
                ) : null}
              </tr>
            )
          })}
        </tbody>
      </table>

      {processes.length === 0 && (
        <div className="mmt-process-table-empty">
          暂无进程数据，请确认目标应用正在运行
        </div>
      )}
    </div>
  )
}

export default ProcessTable
