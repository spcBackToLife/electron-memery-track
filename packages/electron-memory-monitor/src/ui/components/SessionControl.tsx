import React, { useState } from 'react'

interface SessionControlProps {
  isRunning: boolean
  currentSessionId: string | null
  onStart: (label: string, description?: string) => void
  onStop: () => Promise<unknown> | void
  onTriggerGC: () => void
  /** GC 请求进行中（禁用按钮，避免连点） */
  gcPending?: boolean
  onAddMark: (label: string) => void
  onTakeHeapSnapshot?: () => void
  /** 当前趋势缓冲区内已出现的标记条数（仅展示） */
  markCount?: number
}

const SessionControl: React.FC<SessionControlProps> = ({
  isRunning,
  currentSessionId,
  onStart,
  onStop,
  onTriggerGC,
  gcPending = false,
  onAddMark,
  onTakeHeapSnapshot,
  markCount = 0,
}) => {
  const [label, setLabel] = useState('')
  const [markLabel, setMarkLabel] = useState('')
  const [isStopping, setIsStopping] = useState(false)

  const handleStart = () => {
    if (label.trim()) {
      onStart(label.trim())
      setLabel('')
    }
  }

  const handleStop = async () => {
    setIsStopping(true)
    try {
      await onStop()
    } finally {
      setIsStopping(false)
    }
  }

  const handleMark = () => {
    if (markLabel.trim()) {
      onAddMark(markLabel.trim())
      setMarkLabel('')
    }
  }

  return (
    <div className="session-control">
      <div className="session-control-status">
        <span className={`status-dot ${isRunning ? 'running' : 'idle'}`}></span>
        <span>{isRunning ? `会话进行中: ${currentSessionId?.slice(0, 8)}...` : '未开始会话'}</span>
      </div>

      <div className="session-control-actions">
        {!isRunning ? (
          <div className="session-start-form">
            <input
              type="text"
              placeholder="会话标签（如 v1.2.0 空载基准）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <button type="button" className="btn btn-primary" onClick={handleStart} disabled={!label.trim()}>
              ▶ 开始会话
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-danger" onClick={handleStop} disabled={isStopping}>
            {isStopping ? '⏳ 结束中...' : '⏹ 结束会话'}
          </button>
        )}

        <div className="session-tools">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onTriggerGC}
            disabled={gcPending}
            title="仅主进程 V8；需 --expose-gc 才真正强制 GC，详见点击后提示"
          >
            {gcPending ? '⏳ GC…' : '🗑️ GC'}
          </button>
          {onTakeHeapSnapshot && (
            <button type="button" className="btn btn-secondary" onClick={onTakeHeapSnapshot} title="导出主进程 V8 堆快照">
              📸 堆快照
            </button>
          )}

          <div className="mark-form">
            <input
              type="text"
              placeholder="事件标记"
              value={markLabel}
              onChange={(e) => setMarkLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleMark()}
            />
            <button type="button" className="btn btn-secondary" onClick={handleMark} disabled={!markLabel.trim()}>
              📌 标记
            </button>
            {markCount > 0 && (
              <span className="mark-count-badge" title="当前图表缓冲区内已记录的标记数">
                已记录 {markCount} 条
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default SessionControl
