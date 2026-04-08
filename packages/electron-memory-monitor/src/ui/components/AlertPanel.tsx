import React from 'react'
import type { AnomalyEvent } from '../../types/anomaly'

interface AlertPanelProps {
  anomalies: AnomalyEvent[]
  onClear: () => void
}

const severityConfig = {
  info: { icon: 'ℹ️', color: '#1890ff', bg: 'rgba(24, 144, 255, 0.1)' },
  warning: { icon: '⚠️', color: '#faad14', bg: 'rgba(250, 173, 20, 0.1)' },
  critical: { icon: '🔴', color: '#ff4d4f', bg: 'rgba(255, 77, 79, 0.1)' },
}

const AlertPanel: React.FC<AlertPanelProps> = ({ anomalies, onClear }) => {
  if (anomalies.length === 0) {
    return (
      <div className="alert-panel-empty">
        <span className="alert-panel-empty-icon">✅</span>
        <span>暂无异常检测到</span>
      </div>
    )
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
          return (
            <div
              key={anomaly.id}
              className="alert-item"
              style={{ borderLeftColor: config.color, background: config.bg }}
            >
              <div className="alert-item-header">
                <span className="alert-item-icon">{config.icon}</span>
                <span className="alert-item-title">{anomaly.title}</span>
                <span className="alert-item-time">
                  {new Date(anomaly.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="alert-item-desc">{anomaly.description}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default AlertPanel
