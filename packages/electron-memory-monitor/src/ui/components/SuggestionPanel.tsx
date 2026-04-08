import React from 'react'
import type { Suggestion } from '../../types/report'

interface SuggestionPanelProps {
  suggestions: Suggestion[]
}

const severityConfig = {
  info: { icon: 'ℹ️', color: '#1890ff' },
  warning: { icon: '⚠️', color: '#faad14' },
  critical: { icon: '🔴', color: '#ff4d4f' },
}

const SuggestionPanel: React.FC<SuggestionPanelProps> = ({ suggestions }) => {
  if (suggestions.length === 0) {
    return (
      <div className="suggestion-panel-empty">
        <span>✅ 未发现需要改进的地方</span>
      </div>
    )
  }

  return (
    <div className="suggestion-panel">
      {suggestions.map((suggestion) => {
        const config = severityConfig[suggestion.severity]
        return (
          <div key={suggestion.id} className="suggestion-item" style={{ borderLeftColor: config.color }}>
            <div className="suggestion-header">
              <span className="suggestion-icon">{config.icon}</span>
              <span className="suggestion-title">{suggestion.title}</span>
              <span className="suggestion-category">{suggestion.category}</span>
            </div>
            <p className="suggestion-desc">{suggestion.description}</p>
            <ul className="suggestion-list">
              {suggestion.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {suggestion.relatedCode && suggestion.relatedCode.length > 0 && (
              <div className="suggestion-code">
                {suggestion.relatedCode.map((code, i) => (
                  <code key={i}>{code}</code>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default SuggestionPanel
