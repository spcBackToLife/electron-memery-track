import React, { useEffect, useCallback, useState, useMemo } from 'react'
import MetricCard from '../components/MetricCard'
import ProcessTable from '../components/ProcessTable'
import MemoryTrendChart from '../components/MemoryTrendChart'
import ExternalPerfTrendCharts from '../components/ExternalPerfTrendCharts'
import MemoryDistributionPie from '../components/MemoryDistributionPie'
import SessionControl from '../components/SessionControl'
import AutomationBatchPanel from '../components/AutomationBatchPanel'
import { useSession } from '../hooks/useSession'
import { useToast } from '../context/ToastContext'
import type { MemoryData } from '../hooks/useMemoryData'
import type { MemorySnapshot } from '../types'
import { formatKB, getEffectiveMemoryKB } from '../utils/format'

/** Format bytes to human-readable string */
function fmtMem(kb: number): string {
  if (kb <= 0) return '—'
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** Extract short display name from full exe path: "Game.exe" or "folder\Game.exe" */
function shortExeName(fullPath: string): string {
  if (!fullPath) return '—'
  // Remove quotes if present
  let p = fullPath.replace(/^"|"$/g, '')
  // Get just the filename
  const lastSlash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  const filename = lastSlash >= 0 ? p.slice(lastSlash + 1) : p
  // If filename looks like it has no extension, check if this is actually a command line
  if (filename.includes(' ') || filename.includes('--') || filename.length > 40) {
    // Try to extract actual exe from command-line-like string
    const exeMatch = p.match(/([A-Za-z]:\\[^"]*?\.(?:exe|EXE))/)
    if (exeMatch) {
      const exePath = exeMatch[1]
      const ls = Math.max(exePath.lastIndexOf('\\'), exePath.lastIndexOf('/'))
      const fn = ls >= 0 ? exePath.slice(ls + 1) : exePath
      return fn
    }
    return filename.length > 40 ? filename.slice(0, 38) + '..' : filename
  }
  return filename
}

/** Extract parent folder name for context */
function parentFolder(fullPath: string): string {
  if (!fullPath) return ''
  let p = fullPath.replace(/^"|"$/g, '')
  const lastSlash = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  if (lastSlash < 0) return ''
  const parentPart = p.slice(0, lastSlash)
  const prevSlash = Math.max(parentPart.lastIndexOf('\\'), parentPart.lastIndexOf('/'))
  return prevSlash >= 0 ? parentPart.slice(prevSlash + 1) : parentPart
}

/** 系统进程列表项（来自 C++ enumerateAllProcesses） */
interface ProcessListItem {
  pid: number
  parentPid: number
  name: string
  exePath: string
  /** Private Working Set (KB) — 与任务管理器"内存"列一致 */
  privateWorkingSetKB: number
}

interface DashboardPageProps {
  memoryData: MemoryData
}

const DashboardPage: React.FC<DashboardPageProps> = ({ memoryData }) => {
  const {
    snapshots,
    latestSnapshot,
    addMark,
    markTimeline,
  } = memoryData

  const {
    isRunning,
    currentSessionId,
    startSession: startSessionFromHook,
    stopSession: stopSessionFromHook,
    refreshSessions,
  } = useSession()

  const { showToast } = useToast()

  // ---- 进程搜索选择器状态 ----
  const [processList, setProcessList] = useState<ProcessListItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isFetchingProcesses, setIsFetchingProcesses] = useState(false)
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const [displayTargetInfo, setDisplayTargetInfo] = useState<string | null>(null)
  const [showProcessList, setShowProcessList] = useState(false)
  const [sessionLabel, setSessionLabel] = useState('')
  const [automationApiUrl, setAutomationApiUrl] = useState<string | null>(null)

  useEffect(() => {
    void window.monitorAPI.getAutomationInfo().then((info) => {
      if (info.baseUrl) setAutomationApiUrl(info.baseUrl)
    }).catch(() => { /* ignore */ })
  }, [])

  /** 拉取系统全部进程列表（C++ Toolhelp32） */
  const fetchProcessList = useCallback(async () => {
    setIsFetchingProcesses(true)
    try {
      const raw = await window.monitorAPI.listAllProcesses()
      const list = (raw as Array<Record<string, unknown>>)
        .map((item) => ({
          pid: typeof item.pid === 'number' ? item.pid : Number(item.pid),
          parentPid: typeof item.parentPid === 'number' ? item.parentPid : 0,
          name: typeof item.name === 'string' ? item.name : '',
          exePath: typeof item.exePath === 'string' ? item.exePath : '',
          privateWorkingSetKB: typeof item.privateWorkingSetKB === 'number' ? item.privateWorkingSetKB : 0,
        }))
        .filter((p) => p.pid > 0 && p.name)
        .sort((a, b) => b.privateWorkingSetKB - a.privateWorkingSetKB)
      setProcessList(list)
      if (list.length > 0) setShowProcessList(true)
    } catch (err) {
      console.error('获取进程列表失败:', err)
      showToast('获取进程列表失败，请检查 C++ 原生模块是否已加载', 'error')
      setProcessList([])
    } finally {
      setIsFetchingProcesses(false)
    }
  }, [showToast])

  /** 过滤后的进程列表 */
  const filteredProcesses = useMemo(() => {
    if (!searchQuery.trim()) return processList
    const q = searchQuery.toLowerCase().trim()
    return processList.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      p.exePath.toLowerCase().includes(q) ||
      String(p.pid).includes(q),
    )
  }, [processList, searchQuery])

  /**
   * Process tree analysis: identify root vs child, compute child counts and family memory.
   * Returns enriched items sorted: roots first (by total family memory), then children.
   */
  interface EnrichedProcessItem extends ProcessListItem {
    isRoot: boolean
    childCount: number       /* direct + indirect children within the filtered set */
    familyPrivateKB: number  /* sum of this PID + all its descendants' privateWorkingSetKB */
    depth: number            /* 0 for root, 1+ for children */
    rootPid: number          /* the root PID of this process's tree */
  }

  const enrichedProcesses = useMemo((): EnrichedProcessItem[] => {
    const list = filteredProcesses
    const pidSet = new Set(list.map((p) => p.pid))

    // Build parent -> children map (within full processList for accurate ancestry)
    const childrenMap = new Map<number, number[]>() // parentPid -> [childPids]
    for (const p of list) {
      if (!childrenMap.has(p.parentPid)) childrenMap.set(p.parentPid, [])
      childrenMap.get(p.parentPid)!.push(p.pid)
    }

    // Count all descendants (BFS)
    function countDescendants(pid: number): number {
      const kids = childrenMap.get(pid) || []
      let n = kids.length
      for (const k of kids) n += countDescendants(k)
      return n
    }

    // Sum private KB of all descendants
    function sumFamilyMemory(pid: number): number {
      const proc = list.find((p) => p.pid === pid)
      let total = proc ? proc.privateWorkingSetKB : 0
      for (const kid of (childrenMap.get(pid) || [])) {
        total += sumFamilyMemory(kid)
      }
      return total
    }

    // Find depth and root for each process
    function getDepthAndRoot(
      pid: number,
      visited: Set<number> = new Set(),
    ): { depth: number; rootPid: number } {
      if (visited.has(pid)) return { depth: 0, rootPid: pid } // cycle guard
      visited.add(pid)
      const proc = list.find((p) => p.pid === pid)
      if (!proc || proc.parentPid === 0 || !pidSet.has(proc.parentPid)) {
        return { depth: 0, rootPid: pid }
      }
      const parent = getDepthAndRoot(proc.parentPid, visited)
      return { depth: parent.depth + 1, rootPid: parent.rootPid }
    }

    const enriched: EnrichedProcessItem[] = list.map((proc) => {
      const isRoot = proc.parentPid === 0 || !pidSet.has(proc.parentPid)
      const childCount = isRoot ? countDescendants(proc.pid) : 0
      const familyKB = isRoot ? sumFamilyMemory(proc.pid) : proc.privateWorkingSetKB
      const { depth, rootPid } = getDepthAndRoot(proc.pid)
      return { ...proc, isRoot, childCount, familyPrivateKB: familyKB, depth, rootPid }
    })

    // Sort: roots first by family memory desc, then children indented under their root
    const roots = enriched.filter((e) => e.isRoot).sort((a, b) => b.familyPrivateKB - a.familyPrivateKB)
    const children = enriched.filter((e) => !e.isRoot).sort((a, b) => b.privateWorkingSetKB - a.privateWorkingSetKB)

    // Interleave: root followed by its immediate children (sorted by memory)
    const ordered: EnrichedProcessItem[] = []
    for (const root of roots) {
      ordered.push(root)
      const rootChildren = children
        .filter((c) => c.rootPid === root.pid)
        .sort((a, b) => b.privateWorkingSetKB - a.privateWorkingSetKB)
      ordered.push(...rootChildren)
    }

    return ordered
  }, [filteredProcesses])

  // ---- 会话控制回调 ----
  const handleStartSession = useCallback(async (label: string) => {
    await startSessionFromHook(label)
    showToast(`测试会话已开始：${label}`, 'success')
  }, [startSessionFromHook, showToast])

  const handleStopSession = useCallback(async () => {
    await stopSessionFromHook()
    showToast('测试会话已结束，报告已生成', 'success')
  }, [stopSessionFromHook, showToast])

  const handleAddMark = useCallback(async (label: string) => {
    await addMark(label)
    showToast(`已添加标记：${label}`, 'info')
  }, [addMark, showToast])

  // ---- 附加到已有进程 ----
  const handleAttachToProcess = useCallback(async () => {
    if (selectedPid == null || selectedPid <= 0) return
    try {
      const result = await window.monitorAPI.attachToProcess(selectedPid, sessionLabel || undefined)
      if (result.success && result.info) {
        setDisplayTargetInfo(`${result.info.appName} (PID ${result.info.pid})`)
        setSearchQuery('')
        setShowProcessList(false)
        setSelectedPid(null)
        setSessionLabel('')
        showToast(`已附加到进程：${result.info.appName} (PID ${result.info.pid})，监控已启动`, 'success')
      } else {
        showToast(result.error || '附加进程失败', 'error')
      }
    } catch (err) {
      console.error(err)
      showToast(`附加失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [selectedPid, sessionLabel, showToast])

  /** 选择进程（高亮） */
  const handleSelectProcess = useCallback((pid: number) => {
    setSelectedPid(pid)
  }, [])

  /** 进程列表中双击直接附加 */
  const handleDoubleClickAttach = useCallback((pid: number) => {
    setSelectedPid(pid)
    // 延迟一 tick 让 selectedPid 更新后再 attach
    setTimeout(() => {
      void window.monitorAPI.attachToProcess(pid, sessionLabel || undefined).then((result) => {
        if (result.success && result.info) {
          setDisplayTargetInfo(`${result.info.appName} (PID ${result.info.pid})`)
          setSearchQuery('')
          setShowProcessList(false)
          setSelectedPid(null)
          setSessionLabel('')
          showToast(`已附加到进程：${result.info.appName}`, 'success')
        } else {
          showToast(result.error || '附加失败', 'error')
        }
      })
    }, 0)
  }, [sessionLabel, showToast])

  // ---- 原有 PID 排除逻辑 ----
  const handleTogglePidInTotal = useCallback(async (pid: number, excluded: boolean) => {
    try {
      await window.monitorAPI.setPidExcludedFromTotal(pid, excluded)
    } catch (err) {
      console.error(err)
      showToast('更新计入范围失败', 'error')
    }
  }, [showToast])

  const handleResetTotalInclusion = useCallback(async () => {
    try {
      await window.monitorAPI.resetTotalExclusion()
      showToast('已恢复为全部进程计入进程树合计', 'success')
    } catch (err) {
      console.error(err)
      showToast('重置失败', 'error')
    }
  }, [showToast])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  /** 会话结束后主进程已 detach，同步清空 UI 上的「当前正在监控」文案 */
  useEffect(() => {
    if (!isRunning) {
      setDisplayTargetInfo(null)
    }
  }, [isRunning])

  useEffect(() => {
    if (!isRunning) return
    void (async () => {
      try {
        const t = await window.monitorAPI.getTargetApp()
        if (t?.appPath) {
          setDisplayTargetInfo(`${t.appName} (PID —)`)
        }
      } catch {
        /* ignore */
      }
    })()
  }, [isRunning])

  /** 必须在任意 early return 之前调用，否则违反 Hooks 顺序规则 */
  const externalRollup = useMemo(() => {
    const externalMonitor = latestSnapshot?.monitorMode === 'external'
    if (!externalMonitor) return null
    const tail = snapshots.length > 400 ? snapshots.slice(-400) : snapshots
    const pts = tail
      .map((s) => s.externalMetrics)
      .filter((x): x is NonNullable<MemorySnapshot['externalMetrics']> => Boolean(x))
    if (pts.length === 0) return null
    const rol = (values: number[]) => {
      if (values.length === 0) return ''
      const max = Math.max(...values)
      const min = Math.min(...values)
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      return `${max.toFixed(1)} / ${min.toFixed(1)} / ${avg.toFixed(1)}`
    }
    const cpus = pts.map((p) => p.aggregateCpuPercent)
    const reads = pts.map((p) => p.diskReadKBps)
    const writes = pts.map((p) => p.diskWriteKBps)
    const gpus = pts.map((p) => p.gpuEnginePercent).filter((x): x is number => x != null)
    const vrams = pts.map((p) => p.gpuDedicatedMB).filter((x): x is number => x != null)
    return {
      cpu: rol(cpus),
      dr: rol(reads),
      dw: rol(writes),
      gpu: gpus.length ? rol(gpus) : '',
      vram: vrams.length ? rol(vrams) : '',
    }
  }, [latestSnapshot?.monitorMode, snapshots])

  const snap = latestSnapshot
  /** 仅在有进行中的会话且最新快照为外部模式时提示，避免结束会话后仍显示旧 PID */
  const externalMonitorForHint = isRunning && snap?.monitorMode === 'external'

  return (
    <div className="mmt-dashboard">
      {/* 进程附加区（置顶） */}
      <div className="mmt-launch-section">
        <h3>选择要监控的应用</h3>
        <p className="section-desc">
          搜索并选择系统中<strong>正在运行</strong>的进程，点击「附加并监控」将对该进程及其子树进行内存/CPU/GPU 监控。
          数据由{' '}
          <strong>memory_native（C++ / Win32 API）</strong>{' '}
          实时采集，无需启动新实例。
          「内存」列为<strong>专用工作集</strong>（对齐任务管理器「内存」）；进程表另有<strong>专用提交</strong>（privateBytes /
          PrivateUsage），通常更大。趋势图与合计卡片同时展示两条曲线/数值便于对比。
          {externalMonitorForHint ? (
            <>
              {' '}当前正在监控：<strong>{displayTargetInfo || snap?.externalRootPid}</strong>。
            </>
          ) : (
            <> 未附加外部进程时，下方数据为本监控工具自身。</>
          )}
          {automationApiUrl ? (
            <>
              {' '}
              自动化 API：<code>{automationApiUrl}</code>（跑场景 <code>pnpm scenario</code> /
              录制 <code>pnpm scenario:codegen</code>，需被测应用已开 9222）。
            </>
          ) : null}
        </p>

        {/* 搜索 + 刷新 + 附件按钮 */}
        <div className="process-selector-row">
          <div className="process-search-input-wrap">
            <input
              type="text"
              className="process-search-input"
              placeholder="输入进程名、路径或 PID 搜索…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                if (!showProcessList && processList.length > 0) setShowProcessList(true)
              }}
              onFocus={() => {
                if (processList.length > 0) setShowProcessList(true)
                else void fetchProcessList()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filteredProcesses.length > 0) {
                  handleSelectProcess(filteredProcesses[0].pid)
                  setShowProcessList(true)
                }
              }}
            />
            {searchQuery && (
              <button
                className="process-search-clear"
                type="button"
                onClick={() => { setSearchQuery(''); setSelectedPid(null) }}
              >
                x
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void fetchProcessList()}
            disabled={isFetchingProcesses}
          >
            {isFetchingProcesses ? '刷新中...' : '刷新进程列表'}
          </button>
          <input
            type="text"
            className="process-session-input"
            placeholder="会话名称（可选）"
            value={sessionLabel}
            onChange={(e) => setSessionLabel(e.target.value)}
          />
          <button
            className="btn btn-primary"
            onClick={handleAttachToProcess}
            disabled={selectedPid == null}
          >
            附加并监控{selectedPid != null ? ` (PID ${selectedPid})` : ''}
          </button>
        </div>

        {/* 进程下拉列表 */}
        {showProcessList && (
          <div className="process-list-dropdown">
            {filteredProcesses.length === 0 ? (
              <div className="process-list-empty">
                {isFetchingProcesses ? '正在从 C++ 枚举系统进程...' : '无匹配进程'}
              </div>
            ) : (
              <table className="process-list-table">
                <thead>
                  <tr>
                    <th className="col-pid">PID</th>
                    <th className="col-name">进程名</th>
                    <th className="col-path">所在目录</th>
                    <th className="col-mem">专用内存</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedProcesses.filter((e) => e.isRoot).slice(0, 200).map((proc) => {
                    const isSelected = selectedPid === proc.pid
                    const displayName = shortExeName(proc.name || proc.exePath)
                    const folder = parentFolder(proc.exePath)
                    const isRoot = proc.isRoot
                    return (
                      <tr
                        key={proc.pid}
                        className={`${isSelected ? 'selected' : ''} ${isRoot ? 'row-root' : 'row-child'}`}
                        style={{ '--indent-px': `${(proc.depth || 0) * 20}px` } as React.CSSProperties}
                        onClick={() => handleSelectProcess(proc.pid)}
                        onDoubleClick={() => handleDoubleClickAttach(proc.pid)}
                        title={`${isRoot ? '[主进程]' : '[子进程]'} 双击快速附加\nPID: ${proc.pid}\n父进程: PPID ${proc.parentPid}\n完整路径: ${proc.exePath}\n专用内存: ${fmtMem(proc.privateWorkingSetKB)}${isRoot && proc.childCount > 0 ? `\n包含 ${proc.childCount} 个子进程 (合计 ${fmtMem(proc.familyPrivateKB)})` : ''}`}
                      >
                        <td className="col-pid">
                          {isRoot && proc.childCount > 0 && (
                            <span className="root-badge" title={`主进程，包含 ${proc.childCount} 个子进程`}>ROOT</span>
                          )}
                          {proc.pid}
                        </td>
                        <td className="col-name">
                          <span className={`proc-name-main ${isRoot ? 'root-name' : ''}`}>{displayName}</span>
                          {isRoot && proc.childCount > 0 && (
                            <span className="proc-name-sub root-info">
                              {proc.childCount} 个子进程 · 合计 {fmtMem(proc.familyPrivateKB)}
                            </span>
                          )}
                          {!isRoot && folder && folder !== displayName && (
                            <span className="proc-name-sub">{folder}</span>
                          )}
                        </td>
                        <td className="col-path" title={proc.exePath}>
                          {(!isRoot && folder) ? folder : (
                            proc.exePath.length > 45
                              ? proc.exePath.slice(0, 43) + '..'
                              : proc.exePath
                          )}
                        </td>
                        <td className="col-mem">
                          {fmtMem(proc.privateWorkingSetKB)}
                          {isRoot && proc.childCount > 0 && (
                            <span className="family-total">({fmtMem(proc.familyPrivateKB)})</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {filteredProcesses.length > 200 && (
              <div className="process-list-more">仅显示前 200 条匹配结果，请缩小搜索范围</div>
            )}
          </div>
        )}
      </div>

      <AutomationBatchPanel />

      {/* 会话控制 */}
      <SessionControl
        isRunning={isRunning}
        currentSessionId={currentSessionId}
        onStart={handleStartSession}
        onStop={handleStopSession}
        onAddMark={handleAddMark}
        markCount={markTimeline.length}
        targetAppPath={displayTargetInfo}
      />

      {!isRunning && !snap ? (
        <div className="mmt-waiting-first-snap">
          <p>当前未在采集。请搜索进程并点击「附加并监控」，或填写测试名称后点击「开始记录」。</p>
        </div>
      ) : null}
      {isRunning && !snap ? (
        <div className="mmt-waiting-first-snap">
          <div className="loading-spinner" />
          <p>正在等待首帧内存快照...</p>
          <p className="loading-hint">
            首拍可能包含子树异步采集，需数秒属正常。此期间仍可使用上方进程搜索与附加功能。
          </p>
        </div>
      ) : null}

      {snap
        ? (() => {
            const s = snap
            const externalMonitor = s.monitorMode === 'external'
            const rootPid = s.externalRootPid
            const externalIncludedPidsFallback = externalMonitor
              ? s.externalTotalIncludedPids ?? s.processes.map((p) => p.pid)
              : undefined
            const includedPidSet = new Set(
              externalIncludedPidsFallback ?? s.processes.map((p) => p.pid),
            )
            const browserProcess =
              externalMonitor && rootPid != null
                ? s.processes.find((p) => p.pid === rootPid)
                : s.processes.find((p) => p.type === 'Browser')
            const rendererProcesses =
              externalMonitor && rootPid != null
                ? s.processes.filter((p) => p.pid !== rootPid)
                : s.processes.filter((p) => p.type === 'Tab')
            const rendererProcessesInTotal =
              externalMonitor && rootPid != null
                ? rendererProcesses.filter((p) => includedPidSet.has(p.pid))
                : rendererProcesses
            const rendererIncludedMem = rendererProcessesInTotal.reduce(
              (acc, p) => acc + getEffectiveMemoryKB(p.memory),
              0,
            )
            const externalMetrics = s.externalMetrics

            return (
              <>
      {/* 指标卡片 - 面向测试的简化指标 */}
      <div className="mmt-metric-cards-row">
        <MetricCard
          icon="💻"
          title={externalMonitor ? '进程树合计' : '总内存'}
          value={formatKB(s.totalWorkingSetSize)}
          color="#646cff"
        />
        <MetricCard
          icon="📦"
          title={externalMonitor ? '专用提交合计' : '总专用提交'}
          value={formatKB(s.totalPrivateBytes ?? 0)}
          detail="Win32 PrivateUsage / Chromium privateBytes"
          color="#b37feb"
        />
        <MetricCard
          icon="🧠"
          title="主进程"
          value={formatKB(browserProcess ? getEffectiveMemoryKB(browserProcess.memory) : 0)}
          color="#f5a623"
        />
        <MetricCard
          icon="🖼️"
          title={externalMonitor ? '计入合计的子进程' : '渲染进程'}
          value={formatKB(externalMonitor ? rendererIncludedMem : rendererProcesses.reduce((acc, p) => acc + getEffectiveMemoryKB(p.memory), 0))}
          unit={`(${externalMonitor ? rendererProcessesInTotal.length : rendererProcesses.length}个)`}
          color="#61dafb"
        />
        <MetricCard icon="⚙️" title="系统内存" value={`${s.system.usagePercent}%`} color="#ff6b6b" />
        <MetricCard icon="🔢" title="进程数" value={`${s.processes.length}`} color="#8b8b8b" />
      </div>

      {externalMonitor && externalMetrics ? (
        <div className="mmt-metric-cards-row mmt-metric-cards-row-external">
          <MetricCard
            icon="📊"
            title="CPU 合计（子树）"
            value={`${externalMetrics.aggregateCpuPercent}%`}
            detail={[externalRollup?.cpu, '相邻两拍差分，首拍为 0'].filter(Boolean).join('\n')}
            color="#52c41a"
          />
          <MetricCard
            icon="📀"
            title="磁盘读取（子树）"
            value={`${externalMetrics.diskReadKBps}`}
            unit="KB/s"
            detail={[externalRollup?.dr, 'GetProcessIoCounters 累计字节 ÷ 采样间隔'].filter(Boolean).join('\n')}
            color="#faad14"
          />
          <MetricCard
            icon="💾"
            title="磁盘写入（子树）"
            value={`${externalMetrics.diskWriteKBps}`}
            unit="KB/s"
            detail={[externalRollup?.dw, '同上'].filter(Boolean).join('\n')}
            color="#eb2f96"
          />
          <MetricCard
            icon="🎮"
            title="GPU 引擎"
            value={externalMetrics.gpuEnginePercent != null ? `${externalMetrics.gpuEnginePercent}` : '-'}
            unit={externalMetrics.gpuEnginePercent != null ? '%' : undefined}
            detail={externalRollup?.gpu || undefined}
            color="#ff6b6b"
          />
          <MetricCard
            icon="🧩"
            title="GPU 显存"
            value={externalMetrics.gpuDedicatedMB != null ? `${externalMetrics.gpuDedicatedMB}` : '-'}
            unit={externalMetrics.gpuDedicatedMB != null ? 'MB' : undefined}
            detail={externalRollup?.vram || undefined}
            color="#9254de"
          />
        </div>
      ) : null}

      {/* 图表行 */}
      <div className="charts-row">
        <div className="chart-container chart-wide">
          <h3>📈 内存趋势</h3>
          <p className="chart-caption">
            {externalMonitor ? (
              <>
                <strong>进程树合计</strong>（紫色）为勾选「计入合计」后的汇总；彩色折线为<strong>各 PID 单独占用</strong>
                （按本会话内峰值内存取前 12 名，其余进程合并为灰色虚线「其余...合计」）。关注单条曲线持续爬升可定位到具体子进程。
              </>
            ) : (
              <>
                展示总内存及各类型进程的实时变化趋势。关注曲线是否持续上升——这可能是内存泄漏的信号。
                使用「事件标记」记录关键操作点，方便后续定位问题。
              </>
            )}
          </p>
          <MemoryTrendChart snapshots={snapshots} marksSource={snapshots} height={320} />
        </div>
        <div className="chart-container chart-narrow">
          <h3>🥧 进程分布</h3>
          <p className="chart-caption">各类型进程的内存占比</p>
          <MemoryDistributionPie
            processes={s.processes}
            height={300}
            externalMonitor={externalMonitor}
            externalTotalIncludedPids={externalIncludedPidsFallback}
          />
        </div>
      </div>

      {externalMonitor ? (
        <section className="mmt-resource-section">
          <h3 className="mmt-resource-section-title">🖥️ 资源性能趋势（CPU · 磁盘 · GPU）</h3>
          <p className="chart-caption">
            与上方指标卡同源；子树内全部 PID 汇总。首拍 CPU/磁盘速率为 0；GPU 引擎% / 专用显存为 PDH 中匹配子树 PID 的实例汇总（与任务管理器进程视图一致，受驱动影响可能有偏差）。
          </p>
          <ExternalPerfTrendCharts snapshots={snapshots} layout="featured" />
        </section>
      ) : (
        <p className="mmt-self-monitor-hint chart-caption">
          当前为<strong>自监控</strong>模式：仅展示本工具 Electron 内存曲线。若需 CPU/磁盘/GPU 进程树级趋势，请使用上方「附加并监控」功能。
        </p>
      )}

      {/* 进程表格 */}
      <div className="section">
        <h3>📋 进程列表</h3>
        <p className="table-caption">
          {externalMonitor
            ? '列出根 PID 子树内全部进程（按内存降序）。「计入合计」影响进程树合计内存及 CPU/磁盘汇总卡片；各 PID 分线仍显示该进程实际占用与磁盘速率。默认全选。'
            : '列出本工具（Electron）各子进程内存占用，按内存降序排列。'}
        </p>
        {externalMonitor ? (
          <div className="mmt-external-total-toolbar">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleResetTotalInclusion()}>
              全部计入合计
            </button>
            <span className="mmt-external-total-hint">
              测试报告会记录结束时仍计入合计的 PID 列表。
            </span>
          </div>
        ) : null}
        <ProcessTable
          processes={s.processes}
          externalMonitor={externalMonitor}
          externalTotalIncludedPids={externalIncludedPidsFallback}
          onTogglePidInTotal={externalMonitor ? handleTogglePidInTotal : undefined}
        />
      </div>

              </>
            )
          })()
        : null}

      {/* 测试提示 */}
      <div className="section mmt-test-tips">
        <h3>💡 测试提示</h3>
        <ul className="tips-list">
          <li><strong>基线对比：</strong>先运行一次「开始记录」作为基线，后续版本在同一操作路径下再次录制，然后在「回归对比」页面对比。</li>
          <li><strong>关注趋势：</strong>单次测试中如果看到内存曲线持续上升且不回落，可能存在泄漏。</li>
          <li><strong>标记关键点：</strong>在执行重要操作前后添加标记，方便分析哪个阶段内存增长最多。</li>
          <li><strong>长时间运行：</strong>建议至少观察 10-30 分钟，短时间内的波动可能是正常 GC 行为。</li>
        </ul>
      </div>
    </div>
  )
}

export default DashboardPage
