/**
 * Analyzer - 报告分析 & 改进建议引擎
 * 
 * 负责：
 * 1. 从快照数据生成统计汇总（SessionReport）
 * 2. 对比两个会话（CompareReport）
 * 3. 基于模式识别生成改进建议
 */

import * as os from 'os'
import { percentile, average, linearRegression, kbToBytes } from './utils'
import type { MemorySnapshot } from '../types/snapshot'
import type { AnomalyEvent } from '../types/anomaly'
import type {
  SessionReport,
  MetricSummary,
  TrendInfo,
  Suggestion,
  CompareReport,
  MetricDiff,
  Regression,
  Improvement,
} from '../types/report'

export class Analyzer {
  /** 生成会话报告 */
  generateReport(
    sessionId: string,
    label: string,
    description: string | undefined,
    startTime: number,
    endTime: number,
    snapshots: MemorySnapshot[],
    anomalies: AnomalyEvent[],
    dataFile: string
  ): SessionReport {
    if (snapshots.length === 0) {
      throw new Error('No snapshots to analyze')
    }

    const environment = this.collectEnvironment()
    const summary = this.computeSummary(snapshots)
    const suggestions = this.generateSuggestions(snapshots, summary, anomalies)

    return {
      sessionId,
      label,
      description,
      startTime,
      endTime,
      duration: endTime - startTime,
      environment,
      summary,
      anomalies,
      suggestions,
      dataFile,
    }
  }

  /** 对比两个会话报告 */
  compareReports(base: SessionReport, target: SessionReport): CompareReport {
    const overall = {
      totalMemory: this.diffMetric(base.summary.totalMemory, target.summary.totalMemory),
      browserMemory: this.diffMetric(base.summary.byProcessType.browser, target.summary.byProcessType.browser),
      rendererMemory: this.diffMetricArrayAvg(
        base.summary.byProcessType.renderer,
        target.summary.byProcessType.renderer
      ),
      gpuMemory: base.summary.byProcessType.gpu && target.summary.byProcessType.gpu
        ? this.diffMetric(base.summary.byProcessType.gpu, target.summary.byProcessType.gpu)
        : null,
    }

    const v8Heap = {
      heapUsed: this.diffMetric(base.summary.mainV8Heap.heapUsed, target.summary.mainV8Heap.heapUsed),
      heapTotal: this.diffMetric(base.summary.mainV8Heap.heapTotal, target.summary.mainV8Heap.heapTotal),
      external: this.diffMetric(base.summary.mainV8Heap.external, target.summary.mainV8Heap.external),
    }

    const trendChanges = this.compareTrends(base.summary.trends, target.summary.trends)
    const regressions = this.findRegressions(overall, v8Heap)
    const improvements = this.findImprovements(overall, v8Heap)
    const { verdict, verdictReason } = this.determineVerdict(regressions, overall)

    return {
      base: { sessionId: base.sessionId, label: base.label },
      target: { sessionId: target.sessionId, label: target.label },
      overall,
      v8Heap,
      trendChanges,
      regressions,
      improvements,
      verdict,
      verdictReason,
    }
  }

  // ===== 私有方法 =====

  private collectEnvironment(): SessionReport['environment'] {
    const cpus = os.cpus()
    return {
      electronVersion: process.versions.electron || 'unknown',
      chromeVersion: process.versions.chrome || 'unknown',
      nodeVersion: process.versions.node || 'unknown',
      platform: process.platform,
      arch: process.arch,
      totalSystemMemory: os.totalmem(),
      cpuModel: cpus.length > 0 ? cpus[0].model : 'unknown',
      cpuCores: cpus.length,
    }
  }

  private computeSummary(snapshots: MemorySnapshot[]): SessionReport['summary'] {
    const timestamps = snapshots.map((s) => s.timestamp)

    // 总进程数
    const processCounts = snapshots.map((s) => s.processes.length)

    // 总内存 (KB)
    const totalMemoryValues = snapshots.map((s) => s.totalWorkingSetSize)

    // 按类型分组
    const browserValues = snapshots.map((s) =>
      s.processes.filter((p) => p.type === 'Browser').reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    )

    // 渲染进程 - 收集每个渲染进程的数据
    const rendererSummaries = this.computeRendererSummaries(snapshots)

    // GPU 进程
    const gpuValues = snapshots.map((s) =>
      s.processes.filter((p) => p.type === 'GPU').reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    )
    const hasGpu = gpuValues.some((v) => v > 0)

    // Utility 进程
    const utilityValues = snapshots.map((s) =>
      s.processes.filter((p) => p.type === 'Utility').reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    )
    const hasUtility = utilityValues.some((v) => v > 0)

    // V8 堆（bytes）
    const heapUsedValues = snapshots.map((s) => s.mainProcessMemory.heapUsed)
    const heapTotalValues = snapshots.map((s) => s.mainProcessMemory.heapTotal)
    const externalValues = snapshots.map((s) => s.mainProcessMemory.external)
    const arrayBufferValues = snapshots.map((s) => s.mainProcessMemory.arrayBuffers)

    // 渲染进程总内存
    const rendererTotalValues = snapshots.map((s) =>
      s.processes.filter((p) => p.type === 'Tab' && !p.isMonitorProcess).reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    )

    return {
      totalProcesses: {
        min: Math.min(...processCounts),
        max: Math.max(...processCounts),
        avg: Math.round(average(processCounts)),
      },
      totalMemory: this.computeMetricSummary(totalMemoryValues),
      byProcessType: {
        browser: this.computeMetricSummary(browserValues),
        renderer: rendererSummaries,
        gpu: hasGpu ? this.computeMetricSummary(gpuValues) : null,
        utility: hasUtility ? this.computeMetricSummary(utilityValues) : null,
      },
      mainV8Heap: {
        heapUsed: this.computeMetricSummary(heapUsedValues),
        heapTotal: this.computeMetricSummary(heapTotalValues),
        external: this.computeMetricSummary(externalValues),
        arrayBuffers: this.computeMetricSummary(arrayBufferValues),
      },
      trends: {
        totalMemory: this.computeTrend(totalMemoryValues, timestamps),
        browserMemory: this.computeTrend(browserValues, timestamps),
        rendererMemory: this.computeTrend(rendererTotalValues, timestamps),
      },
    }
  }

  private computeRendererSummaries(snapshots: MemorySnapshot[]): MetricSummary[] {
    // 收集所有出现过的渲染进程 PID（排除监控面板自身）
    const allPids = new Set<number>()
    for (const snapshot of snapshots) {
      for (const p of snapshot.processes) {
        if (p.type === 'Tab' && !p.isMonitorProcess) {
          allPids.add(p.pid)
        }
      }
    }

    // 对每个 PID 计算汇总
    const summaries: MetricSummary[] = []
    for (const pid of allPids) {
      const values = snapshots
        .map((s) => {
          const proc = s.processes.find((p) => p.pid === pid)
          return proc ? proc.memory.workingSetSize : null
        })
        .filter((v): v is number => v !== null)

      if (values.length > 0) {
        summaries.push(this.computeMetricSummary(values))
      }
    }

    return summaries
  }

  private computeMetricSummary(values: number[]): MetricSummary {
    if (values.length === 0) {
      return { initial: 0, final: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, delta: 0, deltaPercent: 0 }
    }

    const initial = values[0]
    const final = values[values.length - 1]
    const delta = final - initial
    const deltaPercent = initial !== 0 ? (delta / initial) * 100 : 0

    return {
      initial,
      final,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round(average(values)),
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      p99: Math.round(percentile(values, 99)),
      delta: Math.round(delta),
      deltaPercent: Math.round(deltaPercent * 100) / 100,
    }
  }

  private computeTrend(values: number[], timestamps: number[]): TrendInfo {
    if (values.length < 10) {
      return { slope: 0, r2: 0, direction: 'stable', confidence: 'low' }
    }

    const { slope, r2 } = linearRegression(values, timestamps)

    let direction: TrendInfo['direction'] = 'stable'
    if (slope > 1 && r2 > 0.3) direction = 'growing'
    else if (slope < -1 && r2 > 0.3) direction = 'shrinking'

    let confidence: TrendInfo['confidence'] = 'low'
    if (r2 > 0.8) confidence = 'high'
    else if (r2 > 0.5) confidence = 'medium'

    return { slope, r2, direction, confidence }
  }

  private generateSuggestions(
    snapshots: MemorySnapshot[],
    summary: SessionReport['summary'],
    _anomalies: AnomalyEvent[]
  ): Suggestion[] {
    const suggestions: Suggestion[] = []
    const latest = snapshots[snapshots.length - 1]

    // 规则1：分离上下文
    if (latest.mainProcessV8Detail?.numberOfDetachedContexts > 0) {
      suggestions.push({
        id: 'detached-contexts',
        severity: 'critical',
        category: 'memory-leak',
        title: '检测到分离的 V8 上下文 (Detached Contexts)',
        description: `发现 ${latest.mainProcessV8Detail.numberOfDetachedContexts} 个分离上下文，通常意味着存在未正确销毁的 BrowserWindow 或 WebContents 实例。`,
        suggestions: [
          '检查所有 BrowserWindow 是否在关闭时调用了 destroy()',
          '检查是否有闭包持有已关闭窗口的 webContents 引用',
          '使用 Chrome DevTools Memory 面板做堆快照，搜索 "Detached" 关键字',
          '检查 ipcMain.on 监听器是否在窗口关闭后正确移除',
        ],
        relatedCode: [
          'win.on("closed", () => { win = null })',
          'win.destroy()  // 而不仅仅是 win.close()',
        ],
      })
    }

    // 规则2：主进程内存持续增长
    if (summary.trends.browserMemory.direction === 'growing' && summary.trends.browserMemory.confidence === 'high') {
      suggestions.push({
        id: 'main-process-leak',
        severity: 'warning',
        category: 'memory-leak',
        title: '主进程内存存在持续增长趋势',
        description: `主进程内存以 ${summary.trends.browserMemory.slope.toFixed(2)} KB/s 的速率增长 (R²=${summary.trends.browserMemory.r2.toFixed(3)})`,
        suggestions: [
          '检查主进程中是否有未清理的 setInterval/setTimeout',
          '检查 ipcMain.on 是否存在重复注册',
          '检查是否有持续增长的 Map/Set/Array 缓存未设置上限',
          '检查 EventEmitter 监听器是否正确移除',
          '运行 --expose-gc 并手动触发 GC，观察内存是否回落',
        ],
      })
    }

    // 规则3：渲染进程内存过高
    const highRenderers = summary.byProcessType.renderer.filter((r) => r.max > 300 * 1024)
    if (highRenderers.length > 0) {
      suggestions.push({
        id: 'renderer-memory-high',
        severity: 'warning',
        category: 'optimization',
        title: '渲染进程内存占用过高',
        description: `有 ${highRenderers.length} 个渲染进程内存峰值超过 300MB`,
        suggestions: [
          '检查是否加载了过大的图片资源（考虑懒加载/压缩）',
          '检查 DOM 节点数量（超过 1500 个节点会显著增加内存）',
          '检查是否有大量未销毁的 React 组件实例',
          '考虑使用虚拟列表（Virtual List）替代长列表',
          '检查 Canvas/WebGL 资源是否正确释放',
        ],
      })
    }

    // 规则4：V8 堆使用率过高
    const { heapUsed, heapTotal } = summary.mainV8Heap
    if (heapTotal.avg > 0 && heapUsed.avg / heapTotal.avg > 0.8) {
      suggestions.push({
        id: 'gc-ineffective',
        severity: 'warning',
        category: 'memory-leak',
        title: 'V8 堆使用率长期偏高 (>80%)',
        description: '堆使用率长期超过 80%，GC 无法有效释放内存，疑似存在内存泄漏',
        suggestions: [
          '导出堆快照 (Heap Snapshot)，使用 Chrome DevTools 分析对象留存',
          '对比两个时间点的堆快照，查找 "Allocated between snapshots" 中的泄漏对象',
          '检查 Event Listeners 是否正确清理',
          '检查 Promise 链是否有未处理的 rejection 导致引用未释放',
        ],
      })
    }

    // 规则5：ArrayBuffer 偏高
    if (summary.mainV8Heap.arrayBuffers.avg > 50 * 1024 * 1024) {
      suggestions.push({
        id: 'arraybuffer-high',
        severity: 'info',
        category: 'optimization',
        title: 'ArrayBuffer 内存占用偏高',
        description: 'ArrayBuffer 平均占用超过 50MB',
        suggestions: [
          '检查 Buffer.alloc / Buffer.from 的使用，确保用完后不再持有引用',
          '如果使用 IPC 传输大数据，考虑分片传输或使用 MessagePort',
          '检查 Blob/File 对象是否及时释放',
        ],
      })
    }

    // 规则6：进程数过多
    if (summary.totalProcesses.max > 10) {
      suggestions.push({
        id: 'too-many-processes',
        severity: 'warning',
        category: 'architecture',
        title: `进程数量偏多 (最高 ${summary.totalProcesses.max} 个)`,
        description: '过多的进程会显著增加内存开销',
        suggestions: [
          '检查是否创建了不必要的 BrowserWindow',
          '考虑复用窗口而非每次创建新窗口',
          '使用 webContents.setBackgroundThrottling(true) 减少后台进程开销',
        ],
      })
    }

    // 规则7：old_space 占比过高
    if (latest.mainProcessV8Detail?.heapSpaces) {
      const oldSpace = latest.mainProcessV8Detail.heapSpaces.find((s) => s.name === 'old_space')
      const totalUsed = latest.mainProcessV8Detail.heapSpaces.reduce((sum, s) => sum + s.usedSize, 0)
      if (oldSpace && totalUsed > 0 && oldSpace.usedSize / totalUsed > 0.85) {
        suggestions.push({
          id: 'old-space-dominant',
          severity: 'info',
          category: 'optimization',
          title: 'V8 old_space 占比超过 85%',
          description: '大量对象存活到 old generation，可能存在长生命周期的大对象或缓存未回收',
          suggestions: [
            '使用堆快照分析 old_space 中的大对象',
            '检查全局缓存是否设置了过期策略或容量上限',
            '考虑使用 WeakMap/WeakRef 替代强引用缓存',
            '检查闭包是否意外持有大量外部变量',
          ],
        })
      }
    }

    return suggestions
  }

  private diffMetric(base: MetricSummary, target: MetricSummary): MetricDiff {
    const delta = target.avg - base.avg
    const deltaPercent = base.avg !== 0 ? (delta / base.avg) * 100 : 0

    let status: MetricDiff['status'] = 'unchanged'
    if (deltaPercent > 3) status = 'degraded'
    else if (deltaPercent < -3) status = 'improved'

    let severity: MetricDiff['severity']
    if (Math.abs(deltaPercent) > 15) severity = 'critical'
    else if (Math.abs(deltaPercent) > 5) severity = 'major'
    else severity = 'minor'

    return {
      base: base.avg,
      target: target.avg,
      delta: Math.round(delta),
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      status,
      severity,
    }
  }

  private diffMetricArrayAvg(baseArr: MetricSummary[], targetArr: MetricSummary[]): MetricDiff {
    const baseAvg = baseArr.length > 0 ? average(baseArr.map((s) => s.avg)) : 0
    const targetAvg = targetArr.length > 0 ? average(targetArr.map((s) => s.avg)) : 0
    const baseSummary: MetricSummary = {
      initial: 0, final: 0, min: 0, max: 0, avg: baseAvg,
      p50: 0, p95: 0, p99: 0, delta: 0, deltaPercent: 0,
    }
    const targetSummary: MetricSummary = {
      initial: 0, final: 0, min: 0, max: 0, avg: targetAvg,
      p50: 0, p95: 0, p99: 0, delta: 0, deltaPercent: 0,
    }
    return this.diffMetric(baseSummary, targetSummary)
  }

  private compareTrends(
    baseTrends: SessionReport['summary']['trends'],
    targetTrends: SessionReport['summary']['trends']
  ): CompareReport['trendChanges'] {
    const metrics = ['totalMemory', 'browserMemory', 'rendererMemory'] as const
    return metrics.map((metric) => {
      const baseSlope = baseTrends[metric].slope
      const targetSlope = targetTrends[metric].slope

      let change: 'improved' | 'degraded' | 'unchanged' = 'unchanged'
      if (targetSlope > baseSlope + 1) change = 'degraded'
      else if (targetSlope < baseSlope - 1) change = 'improved'

      return { metric, baseSlope, targetSlope, change }
    })
  }

  private findRegressions(
    overall: CompareReport['overall'],
    v8Heap: CompareReport['v8Heap']
  ): Regression[] {
    const regressions: Regression[] = []

    const checks: { metric: string; diff: MetricDiff; warnThreshold: number; failThreshold: number }[] = [
      { metric: '总内存', diff: overall.totalMemory, warnThreshold: 5, failThreshold: 15 },
      { metric: '主进程内存', diff: overall.browserMemory, warnThreshold: 10, failThreshold: 25 },
      { metric: '渲染进程内存', diff: overall.rendererMemory, warnThreshold: 10, failThreshold: 25 },
      { metric: 'V8 Heap Used', diff: v8Heap.heapUsed, warnThreshold: 10, failThreshold: 30 },
    ]

    for (const check of checks) {
      if (check.diff.deltaPercent > check.warnThreshold) {
        regressions.push({
          metric: check.metric,
          description: `${check.metric}增长 ${check.diff.deltaPercent.toFixed(1)}%`,
          baseValue: check.diff.base,
          targetValue: check.diff.target,
          deltaPercent: check.diff.deltaPercent,
          severity: check.diff.deltaPercent > check.failThreshold ? 'critical' : 'major',
          suggestion: `${check.metric}增长超过预期，建议检查新增代码中的内存使用`,
        })
      }
    }

    return regressions
  }

  private findImprovements(
    overall: CompareReport['overall'],
    v8Heap: CompareReport['v8Heap']
  ): Improvement[] {
    const improvements: Improvement[] = []

    const checks: { metric: string; diff: MetricDiff }[] = [
      { metric: '总内存', diff: overall.totalMemory },
      { metric: '主进程内存', diff: overall.browserMemory },
      { metric: 'V8 Heap Used', diff: v8Heap.heapUsed },
    ]

    for (const check of checks) {
      if (check.diff.deltaPercent < -3) {
        improvements.push({
          metric: check.metric,
          description: `${check.metric}减少 ${Math.abs(check.diff.deltaPercent).toFixed(1)}%`,
          baseValue: check.diff.base,
          targetValue: check.diff.target,
          deltaPercent: check.diff.deltaPercent,
        })
      }
    }

    return improvements
  }

  private determineVerdict(
    regressions: Regression[],
    overall: CompareReport['overall']
  ): { verdict: CompareReport['verdict']; verdictReason: string } {
    const critical = regressions.filter((r) => r.severity === 'critical')
    const major = regressions.filter((r) => r.severity === 'major')

    if (critical.length > 0) {
      return {
        verdict: 'fail',
        verdictReason: `存在 ${critical.length} 项严重劣化：${critical.map((r) => r.metric).join('、')}`,
      }
    }

    if (major.length > 0 || overall.totalMemory.deltaPercent > 5) {
      return {
        verdict: 'warn',
        verdictReason: `存在 ${major.length} 项劣化，总内存变化 ${overall.totalMemory.deltaPercent.toFixed(1)}%`,
      }
    }

    return {
      verdict: 'pass',
      verdictReason: '所有内存指标在正常范围内',
    }
  }
}
