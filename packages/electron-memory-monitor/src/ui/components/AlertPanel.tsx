import React, { useState } from 'react'
import type { AnomalyEvent, AnomalyAction } from '../../types/anomaly'

interface AlertPanelProps {
  anomalies: AnomalyEvent[]
  onClear: () => void
  onAction?: (action: AnomalyAction) => void
}

const severityConfig = {
  info: { icon: 'ℹ️', color: '#1890ff', bg: 'rgba(24, 144, 255, 0.1)' },
  warning: { icon: '⚠️', color: '#faad14', bg: 'rgba(250, 173, 20, 0.1)' },
  critical: { icon: '🔴', color: '#ff4d4f', bg: 'rgba(255, 77, 79, 0.1)' },
}

const AlertPanel: React.FC<AlertPanelProps> = ({ anomalies, onClear, onAction }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (anomalies.length === 0) {
    return (
      <div className="alert-panel-empty">
        <span className="alert-panel-empty-icon">✅</span>
        <span>暂无异常检测到</span>
      </div>
    )
  }

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="alert-panel">
      <div className="alert-panel-header">
        <span>异常告警 ({anomalies.length})</span>
        <button className="alert-panel-clear" onClick={onClear}>清除</button>
      </div>
      <div className="alert-panel-list">
        {anomalies.slice(-10).reverse().map((anomaly) => {
          const config = severityConfig[anomaly.severity]
          const isExpanded = expandedId === anomaly.id
          const hasSuggestions = anomaly.suggestions && anomaly.suggestions.length > 0
          const hasActions = anomaly.actions && anomaly.actions.length > 0
          const hasExtra = hasSuggestions || hasActions

          return (
            <div
              key={anomaly.id}
              className={`alert-item ${isExpanded ? 'alert-item-expanded' : ''}`}
              style={{ borderLeftColor: config.color, background: config.bg }}
            >
              <div
                className="alert-item-header"
                onClick={() => hasExtra && toggleExpand(anomaly.id)}
                style={{ cursor: hasExtra ? 'pointer' : 'default' }}
              >
                <span className="alert-item-icon">{config.icon}</span>
                <span className="alert-item-title">{anomaly.title}</span>
                <span className="alert-item-time">
                  {new Date(anomaly.timestamp).toLocaleTimeString()}
                </span>
                {hasExtra && (
                  <span className="alert-item-toggle">{isExpanded ? '▾' : '▸'}</span>
                )}
              </div>
              <div className="alert-item-desc">{anomaly.description}</div>

              {/* 展开区域：排查建议 + 快捷操作 */}
              {isExpanded && (
                <div className="alert-item-detail">
                  {hasSuggestions && (
                    <div className="alert-suggestions">
                      <div className="alert-suggestions-title">🔍 排查建议</div>
                      <ul className="alert-suggestions-list">
                        {anomaly.suggestions!.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {hasActions && onAction && (
                    <div className="alert-actions">
                      <div className="alert-actions-title">⚡ 快捷操作</div>
                      <div className="alert-actions-btns">
                        {anomaly.actions!.map((action) => (
                          <button
                            key={action.id}
                            className="btn btn-sm alert-action-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              onAction(action)
                            }}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default AlertPanel
