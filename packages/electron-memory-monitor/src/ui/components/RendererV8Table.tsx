import React, { useMemo } from 'react'
import type { ProcessMemoryInfo, RendererV8Detail } from '../../types/snapshot'

interface RendererV8TableProps {
  processes: ProcessMemoryInfo[]
  details?: RendererV8Detail[] | null
  /** 无数据时的简短说明（看板 / 报告文案可不同） */
  emptyHint?: string
}

const formatBytes = (bytes: number | undefined | null): string => {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes === 0) return '0 B'
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function resolveName(processes: ProcessMemoryInfo[], pid: number, webContentsId: number): string {
  const byPid = processes.find((p) => p.pid === pid)
  if (byPid?.name) return byPid.name
  if (byPid?.windowTitle) return byPid.windowTitle
  const byWc = processes.find((p) => p.webContentsId === webContentsId)
  if (byWc?.name) return byWc.name
  if (byWc?.windowTitle) return byWc.windowTitle
  return `渲染进程 PID ${pid}`
}

/**
 * 各渲染进程通过 preload 上报的 Chromium JS 堆（与主进程 Node/V8 无关）。
 * 一行一个 WebContents；多标签即多行，无需切换 Tab 即可在看板看到全部。
 */
const RendererV8Table: React.FC<RendererV8TableProps> = ({
  processes,
  details,
  emptyHint,
}) => {
  const rows = useMemo(() => {
    if (!details?.length) return []
    return [...details].sort((a, b) => a.pid - b.pid)
  }, [details])

  const defaultEmpty =
    '当前快照无渲染进程 V8 数据。请在业务 WebContents 的 preload 中调用 injectRendererReporter()，并设置 enableRendererDetail: true。'

  return (
    <div className="renderer-v8-panel">
      <h3>渲染进程 V8（各标签页 Chromium JS 堆）</h3>
      <p className="renderer-v8-caption">
        数据来自各渲染进程定时 IPC 上报，与上方「主进程 V8」不是同一套运行时。进程表中的<strong>所有</strong> Tab
        行会同时列出，与当前是否激活该标签无关。
      </p>
      {rows.length === 0 ? (
        <p className="renderer-v8-empty">{emptyHint ?? defaultEmpty}</p>
      ) : (
        <div className="report-marks-table-wrap">
          <table className="report-marks-table renderer-v8-table">
            <thead>
              <tr>
                <th>页面 / 标题</th>
                <th>PID</th>
                <th>webContentsId</th>
                <th>Heap Used</th>
                <th>Heap Total</th>
                <th>External</th>
                <th>ArrayBuffers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={`${d.pid}-${d.webContentsId}`}>
                  <td className="mark-label-cell">{resolveName(processes, d.pid, d.webContentsId)}</td>
                  <td>{d.pid}</td>
                  <td>{d.webContentsId}</td>
                  <td>{formatBytes(d.heapUsed)}</td>
                  <td>{formatBytes(d.heapTotal)}</td>
                  <td>{formatBytes(d.external)}</td>
                  <td>{formatBytes(d.arrayBuffers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default RendererV8Table
