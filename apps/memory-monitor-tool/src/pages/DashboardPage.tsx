import React, { useEffect, useCallback, useState, useMemo } from 'react'
import MetricCard from '../components/MetricCard'
import ProcessTable from '../components/ProcessTable'
import MemoryTrendChart from '../components/MemoryTrendChart'
import ExternalPerfTrendCharts from '../components/ExternalPerfTrendCharts'
import MemoryDistributionPie from '../components/MemoryDistributionPie'
import SessionControl from '../components/SessionControl'
import { useSession } from '../hooks/useSession'
import { useToast } from '../context/ToastContext'
import type { MemoryData } from '../hooks/useMemoryData'
import type { MemorySnapshot } from '../types'
import { formatKB, getEffectiveMemoryKB } from '../utils/format'

const LAST_EXE_PATH_KEY = 'mmt_last_exe_path'

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
  const [targetAppPath, setTargetAppPath] = useState('')
  /** 主进程记录的最近一次「启动并监控」目标（刷新页面后仍可拉取） */
  const [displayTargetPath, setDisplayTargetPath] = useState<string | null>(null)

  const persistLastExePath = useCallback((p: string) => {
    try {
      if (p.trim()) localStorage.setItem(LAST_EXE_PATH_KEY, p.trim())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAST_EXE_PATH_KEY)
      if (saved) setTargetAppPath(saved)
    } catch {
      /* ignore */
    }
  }, [])

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

  // 启动外部应用进行监控（主进程会结束当前会话并自动新开一条测试会话）
  const handleLaunchApp = useCallback(async () => {
    if (!targetAppPath.trim()) return
    try {
      const result = await window.monitorAPI.launchApp(targetAppPath.trim())
      if (result.success && result.info) {
        setDisplayTargetPath(result.info.appPath)
        persistLastExePath(result.info.appPath)
        showToast(`已启动并已新建测试会话：${result.info.appName}`, 'success')
      } else {
        showToast(result.error || '启动失败，请检查应用路径', 'error')
      }
    } catch (err) {
      console.error(err)
      showToast(`启动失败: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [targetAppPath, showToast, persistLastExePath])

  const handlePickExecutable = useCallback(async () => {
    try {
      const r = await window.monitorAPI.pickExecutable()
      if (r.canceled) return
      setTargetAppPath(r.path)
      persistLastExePath(r.path)
    } catch (e) {
      console.error(e)
      showToast('选择文件失败', 'error')
    }
  }, [persistLastExePath, showToast])

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

  useEffect(() => {
    void (async () => {
      try {
        const t = await window.monitorAPI.getTargetApp()
        if (t?.appPath) setDisplayTargetPath(t.appPath)
      } catch {
        /* ignore */
      }
    })()
  }, [])

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
      return `高 ${max.toFixed(1)} · 低 ${min.toFixed(1)} · 均 ${avg.toFixed(1)}`
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

  if (!latestSnapshot) {
    return (
      <div className="mmt-loading">
        <div className="loading-spinner"></div>
        <p>正在连接内存采集服务...</p>
        <p className="loading-hint">请确认当前有 Electron 应用在运行</p>
      </div>
    )
  }

  const externalMonitor = latestSnapshot.monitorMode === 'external'
  const rootPid = latestSnapshot.externalRootPid
  const externalIncludedPidsFallback = externalMonitor
    ? latestSnapshot.externalTotalIncludedPids ?? latestSnapshot.processes.map((p) => p.pid)
    : undefined
  const includedPidSet = new Set(
    externalIncludedPidsFallback ?? latestSnapshot.processes.map((p) => p.pid),
  )
  const browserProcess = externalMonitor && rootPid != null
    ? latestSnapshot.processes.find((p) => p.pid === rootPid)
    : latestSnapshot.processes.find((p) => p.type === 'Browser')
  const rendererProcesses = externalMonitor && rootPid != null
    ? latestSnapshot.processes.filter((p) => p.pid !== rootPid)
    : latestSnapshot.processes.filter((p) => p.type === 'Tab')
  const rendererProcessesInTotal =
    externalMonitor && rootPid != null
      ? rendererProcesses.filter((p) => includedPidSet.has(p.pid))
      : rendererProcesses
  const rendererIncludedMem = rendererProcessesInTotal.reduce(
    (s, p) => s + getEffectiveMemoryKB(p.memory),
    0,
  )

  const externalMetrics = latestSnapshot.externalMetrics

  return (
    <div className="mmt-dashboard">
      {/* 外部应用启动区（置顶） */}
      <div className="mmt-launch-section">
        <h3>🎯 启动被监控的应用</h3>
        <p className="section-desc">
          输入要测试的 <strong>.exe</strong> 完整路径，点击「启动并监控」将启动该程序，并<strong>结束当前测试会话、新建一条会话</strong>。
          {externalMonitor ? (
            <>
              当前数据为<strong>根 PID 子树内全部进程</strong>（含升级器等同目录子进程），内存与 CPU/磁盘由{' '}
              <strong>memory_native（C++）</strong> 读取；GPU/显存为 PDH 性能计数器，按<strong>子树 PID</strong>过滤后与任务管理器「进程」列口径一致。
            </>
          ) : (
            <> 未通过此处启动 exe 时，下方数据为<strong>本监控工具</strong>（当前 Electron）的进程内存。</>
          )}
        </p>
        <div className="launch-form-row">
          <input
            type="text"
            placeholder="应用路径 (如 D:\app\my-electron-app.exe)"
            value={targetAppPath}
            onChange={(e) => setTargetAppPath(e.target.value)}
            onBlur={() => {
              if (targetAppPath.trim()) persistLastExePath(targetAppPath.trim())
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleLaunchApp()}
          />
          <button type="button" className="btn btn-secondary" onClick={() => void handlePickExecutable()}>
            📂 浏览…
          </button>
          <button className="btn btn-primary" onClick={handleLaunchApp} disabled={!targetAppPath.trim()}>
            🚀 启动并监控
          </button>
        </div>
      </div>

      {/* 会话控制 */}
      <SessionControl
        isRunning={isRunning}
        currentSessionId={currentSessionId}
        onStart={handleStartSession}
        onStop={handleStopSession}
        onAddMark={handleAddMark}
        markCount={markTimeline.length}
        targetAppPath={displayTargetPath}
      />

      {/* 指标卡片 - 面向测试的简化指标 */}
      <div className="mmt-metric-cards-row">
        <MetricCard
          icon="💻"
          title={externalMonitor ? '进程树合计' : '总内存'}
          value={formatKB(latestSnapshot.totalWorkingSetSize)}
          color="#646cff"
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
          value={formatKB(externalMonitor ? rendererIncludedMem : rendererProcesses.reduce((s, p) => s + getEffectiveMemoryKB(p.memory), 0))}
          unit={`(${externalMonitor ? rendererProcessesInTotal.length : rendererProcesses.length}个)`}
          color="#61dafb"
        />
        <MetricCard icon="⚙️" title="系统内存" value={`${latestSnapshot.system.usagePercent}%`} color="#ff6b6b" />
        <MetricCard icon="🔢" title="进程数" value={`${latestSnapshot.processes.length}`} color="#8b8b8b" />
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
            value={externalMetrics.gpuEnginePercent != null ? `${externalMetrics.gpuEnginePercent}` : '—'}
            unit={externalMetrics.gpuEnginePercent != null ? '%' : undefined}
            detail={externalRollup?.gpu || undefined}
            color="#ff6b6b"
          />
          <MetricCard
            icon="🧩"
            title="GPU 显存"
            value={externalMetrics.gpuDedicatedMB != null ? `${externalMetrics.gpuDedicatedMB}` : '—'}
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
                （按本会话内峰值内存取前 12 名，其余进程合并为灰色虚线「其余…合计」）。关注单条曲线持续爬升可定位到具体子进程。
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
            processes={latestSnapshot.processes}
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
          当前为<strong>自监控</strong>模式：仅展示本工具 Electron 内存曲线。若需 CPU/磁盘/GPU 进程树级趋势，请使用「启动并监控」外部 exe。
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
          processes={latestSnapshot.processes}
          externalMonitor={externalMonitor}
          externalTotalIncludedPids={externalIncludedPidsFallback}
          onTogglePidInTotal={externalMonitor ? handleTogglePidInTotal : undefined}
        />
      </div>

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
