import React from 'react'
import type { V8HeapDetailStats } from '../../types/snapshot'

interface V8HeapDetailProps {
  v8Detail: V8HeapDetailStats
}

const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes === 0) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const V8HeapDetail: React.FC<V8HeapDetailProps> = ({ v8Detail }) => {
  const heapUsagePercent = v8Detail?.heapTotal > 0
    ? Math.round(((v8Detail.heapUsed || 0) / v8Detail.heapTotal) * 100)
    : 0

  return (
    <div className="v8-heap-detail">
      <h3>主进程 V8 堆详情</h3>

      <div className="v8-overview">
        <div className="v8-stat">
          <span className="v8-stat-label">Heap Used</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.heapUsed)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">Heap Total</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.heapTotal)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">使用率</span>
          <span className={`v8-stat-value ${heapUsagePercent > 80 ? 'danger' : heapUsagePercent > 60 ? 'warn' : ''}`}>
            {heapUsagePercent}%
          </span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">External</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.external)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">ArrayBuffers</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.arrayBuffers)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">RSS</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.rss)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">Heap Limit</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.heapSizeLimit)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">Malloced</span>
          <span className="v8-stat-value">{formatBytes(v8Detail.mallocedMemory)}</span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">Detached Contexts</span>
          <span className={`v8-stat-value ${(v8Detail.numberOfDetachedContexts ?? 0) > 0 ? 'danger' : ''}`}>
            {v8Detail.numberOfDetachedContexts ?? 0}
          </span>
        </div>
        <div className="v8-stat">
          <span className="v8-stat-label">Native Contexts</span>
          <span className="v8-stat-value">{v8Detail.numberOfNativeContexts ?? 0}</span>
        </div>
      </div>

      {v8Detail.heapSpaces && v8Detail.heapSpaces.length > 0 && (
        <div className="v8-heap-spaces">
          <h4>堆空间详情</h4>
          <table className="v8-spaces-table">
            <thead>
              <tr>
                <th>空间</th>
                <th>大小</th>
                <th>已使用</th>
                <th>使用率</th>
                <th>可用</th>
              </tr>
            </thead>
            <tbody>
              {v8Detail.heapSpaces.map((space) => {
                const spaceSize = space.size ?? 0
                const spaceUsed = space.usedSize ?? 0
                const spaceAvail = space.availableSize ?? 0
                const usage = spaceSize > 0 ? Math.round((spaceUsed / spaceSize) * 100) : 0
                return (
                  <tr key={space.name}>
                    <td className="space-name">{space.name}</td>
                    <td>{formatBytes(spaceSize)}</td>
                    <td>{formatBytes(spaceUsed)}</td>
                    <td>
                      <div className="usage-bar">
                        <div
                          className="usage-bar-fill"
                          style={{
                            width: `${usage}%`,
                            backgroundColor: usage > 80 ? '#ff4d4f' : usage > 60 ? '#faad14' : '#52c41a',
                          }}
                        />
                        <span className="usage-bar-text">{usage}%</span>
                      </div>
                    </td>
                    <td>{formatBytes(spaceAvail)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default V8HeapDetail
