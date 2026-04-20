import React, { useState } from 'react'

interface SessionControlProps {
  isRunning: boolean
  currentSessionId: string | null
  onStart: (label: string, description?: string) => void
  onStop: () => Promise<void>
  onAddMark: (label: string) => void
  /** 当前标记数量 */
  markCount?: number
  /** 最近一次「启动并监控」的可执行文件路径 */
  targetAppPath?: string | null
}

const SessionControl: React.FC<SessionControlProps> = ({
  isRunning,
  currentSessionId,
  onStart,
  onStop,
  onAddMark,
  markCount = 0,
  targetAppPath,
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
    try { await onStop() } finally { setIsStopping(false) }
  }

  const handleMark = () => {
    if (markLabel.trim()) {
      onAddMark(markLabel.trim())
      setMarkLabel('')
    }
  }

  return (
    <div className="mmt-session-control">
      <div className="mmt-session-status">
        <span className={`status-dot ${isRunning ? 'running' : 'idle'}`}></span>
        <span title={isRunning && currentSessionId ? currentSessionId : undefined}>
          {isRunning && currentSessionId
            ? `会话进行中: ${currentSessionId}`
            : '未开始会话'}
        </span>
        {targetAppPath ? (
          <span className="mmt-target-app-path" title={targetAppPath}>
            已启动目标：<code>{targetAppPath}</code>
          </span>
        ) : null}
      </div>

      <div className="mmt-session-actions">
        {!isRunning ? (
          <div className="start-form">
            <input
              type="text"
              placeholder="测试名称（如 v1.2.0 基线测试）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <button className="btn btn-primary" onClick={handleStart} disabled={!label.trim()}>
              ▶ 开始记录
            </button>
          </div>
        ) : (
          <button className="btn btn-danger" onClick={handleStop} disabled={isStopping}>
            {isStopping ? '⏳ 结束中...' : '⏹ 结束会话'}
          </button>
        )}

        <div className="mark-form">
          <input
            type="text"
            placeholder="事件标记（如「打开标签页」「执行搜索」）"
            value={markLabel}
            onChange={(e) => setMarkLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleMark()}
          />
          <button className="btn btn-secondary" onClick={handleMark} disabled={!markLabel.trim()}>
            📌 标记
          </button>
          {markCount > 0 && (
            <span className="mark-count-badge" title="已标记事件数">已记录 {markCount}</span>
          )}
        </div>
      </div>
    </div>
  )
}

export default SessionControl
