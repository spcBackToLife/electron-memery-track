import React from 'react'
import type { Suggestion } from '../../types/report'

interface SuggestionPanelProps {
  suggestions: Suggestion[]
  onTakeHeapSnapshot?: () => void
  onTriggerGC?: () => void
}

const severityConfig = {
  info: { icon: 'ℹ️', color: '#1890ff' },
  warning: { icon: '⚠️', color: '#faad14' },
  critical: { icon: '🔴', color: '#ff4d4f' },
}

/** 根据建议内容判断是否应展示"堆快照"按钮 */
const shouldShowHeapSnapshotBtn = (suggestion: Suggestion): boolean => {
  const kws = ['堆快照', 'heap snapshot', 'Heap Snapshot', 'Detached']
  const all = [suggestion.title, suggestion.description, ...suggestion.suggestions].join(' ')
  return kws.some((kw) => all.includes(kw))
}

/** 根据建议内容判断是否应展示"GC"按钮 */
const shouldShowGCBtn = (suggestion: Suggestion): boolean => {
  const kws = ['GC', '垃圾回收', '触发 GC', '内存回落']
  const all = [suggestion.title, suggestion.description, ...suggestion.suggestions].join(' ')
  return kws.some((kw) => all.includes(kw))
}

const SuggestionPanel: React.FC<SuggestionPanelProps> = ({
  suggestions,
  onTakeHeapSnapshot,
  onTriggerGC,
}) => {
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
        const showHeap = onTakeHeapSnapshot && shouldShowHeapSnapshotBtn(suggestion)
        const showGC = onTriggerGC && shouldShowGCBtn(suggestion)
        const showActions = showHeap || showGC

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
            {showActions && (
              <div className="suggestion-actions">
                {showHeap && (
                  <button className="btn btn-sm suggestion-action-btn" onClick={onTakeHeapSnapshot}>
                    📸 导出堆快照
                  </button>
                )}
                {showGC && (
                  <button className="btn btn-sm suggestion-action-btn" onClick={onTriggerGC}>
                    🗑️ 触发 GC
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default SuggestionPanel
