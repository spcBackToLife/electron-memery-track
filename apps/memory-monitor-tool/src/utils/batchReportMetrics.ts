import type { ReportSummary } from '../types'
import { computeResourceSummaryFromDataPoints } from './reportResourceSummary'

export interface BatchRunSummaryRow {
  sessionId: string
  runIndex: number
  label: string
  durationMs: number
  snapshotCount: number
  conclusion: ReportSummary['trendAnalysis']['conclusion']
  peakTotalMB: number
  avgTotalMB: number
  finalTotalMB: number
  peakPrivateMB: number | null
  avgPrivateMB: number | null
  finalPrivateMB: number | null
  peakBrowserMB: number
  peakRendererMB: number
  peakProcessCount: number
  peakCpu: number | null
  avgCpu: number | null
  finalCpu: number | null
  peakDiskRead: number | null
  avgDiskRead: number | null
  peakDiskWrite: number | null
  avgDiskWrite: number | null
  peakGpu: number | null
  avgGpu: number | null
  finalGpu: number | null
  peakVram: number | null
  avgVram: number | null
  finalVram: number | null
  outlierReasons: string[]
  excluded: boolean
}

export interface BaselineMetricStat {
  metric: string
  label: string
  unit: string
  min: number
  max: number
  median: number
  mean: number
  stdDev: number
  sampleCount: number
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function stdDev(nums: number[]): number {
  if (nums.length < 2) return 0
  const m = mean(nums)
  const v = nums.reduce((s, x) => s + (x - m) ** 2, 0) / (nums.length - 1)
  return Math.sqrt(v)
}

function iqrOutliers(values: number[], labels: string[]): Set<string> {
  const flagged = new Set<string>()
  if (values.length < 4) return flagged
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)]!
  const q3 = sorted[Math.floor((sorted.length - 1) * 0.75)]!
  const iqr = q3 - q1
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  values.forEach((v, i) => {
    if (v < lo || v > hi) flagged.add(labels[i]!)
  })
  return flagged
}

export function buildRunSummaryRow(report: ReportSummary, runIndex: number): BatchRunSummaryRow {
  const res = report.resourceSummary ?? computeResourceSummaryFromDataPoints(report.dataPoints)
  return {
    sessionId: report.sessionId,
    runIndex,
    label: report.label,
    durationMs: report.durationMs,
    snapshotCount: report.snapshotCount,
    conclusion: report.trendAnalysis.conclusion,
    peakTotalMB: report.summary.peakTotalMB,
    avgTotalMB: report.summary.avgTotalMB,
    finalTotalMB: report.summary.finalTotalMB,
    peakPrivateMB: report.summary.peakTotalPrivateBytesMB ?? null,
    avgPrivateMB: report.summary.avgTotalPrivateBytesMB ?? null,
    finalPrivateMB: report.summary.finalTotalPrivateBytesMB ?? null,
    peakBrowserMB: report.summary.peakBrowserMB,
    peakRendererMB: report.summary.peakRendererMB,
    peakProcessCount: report.summary.peakProcessCount,
    peakCpu: res?.peakCpuPercent ?? null,
    avgCpu: res?.avgCpuPercent ?? null,
    finalCpu: res?.finalCpuPercent ?? null,
    peakDiskRead: res?.peakDiskReadKBps ?? null,
    avgDiskRead: res?.avgDiskReadKBps ?? null,
    peakDiskWrite: res?.peakDiskWriteKBps ?? null,
    avgDiskWrite: res?.avgDiskWriteKBps ?? null,
    peakGpu: res?.peakGpuEnginePercent ?? null,
    avgGpu: res?.avgGpuEnginePercent ?? null,
    finalGpu: res?.finalGpuEnginePercent ?? null,
    peakVram: res?.peakGpuDedicatedMB ?? null,
    avgVram: res?.avgGpuDedicatedMB ?? null,
    finalVram: res?.finalGpuDedicatedMB ?? null,
    outlierReasons: [],
    excluded: false,
  }
}

export function annotateOutliers(rows: BatchRunSummaryRow[]): BatchRunSummaryRow[] {
  const checks: Array<{ key: keyof BatchRunSummaryRow; label: string; get: (r: BatchRunSummaryRow) => number | null }> = [
    { key: 'peakTotalMB', label: '峰值总内存', get: (r) => r.peakTotalMB },
    { key: 'avgTotalMB', label: '平均总内存', get: (r) => r.avgTotalMB },
    { key: 'peakCpu', label: 'CPU 峰值', get: (r) => r.peakCpu },
    { key: 'peakVram', label: '显存峰值', get: (r) => r.peakVram },
  ]

  const next = rows.map((r) => ({ ...r, outlierReasons: [...r.outlierReasons] }))

  for (const c of checks) {
    const pairs = next
      .map((r) => ({ id: r.sessionId, v: c.get(r) }))
      .filter((p): p is { id: string; v: number } => p.v != null && !Number.isNaN(p.v))
    if (pairs.length < 4) continue
    const flagged = iqrOutliers(
      pairs.map((p) => p.v),
      pairs.map((p) => p.id),
    )
    for (const row of next) {
      if (flagged.has(row.sessionId)) {
        row.outlierReasons.push(c.label)
      }
    }
  }
  return next
}

export function computeBaselineStats(
  rows: BatchRunSummaryRow[],
  includedOnly = true,
): BaselineMetricStat[] {
  const active = includedOnly ? rows.filter((r) => !r.excluded) : rows
  const defs: Array<{ metric: string; label: string; unit: string; get: (r: BatchRunSummaryRow) => number | null }> = [
    { metric: 'peakTotalMB', label: '峰值总内存', unit: 'MB', get: (r) => r.peakTotalMB },
    { metric: 'avgTotalMB', label: '平均总内存', unit: 'MB', get: (r) => r.avgTotalMB },
    { metric: 'finalTotalMB', label: '末值总内存', unit: 'MB', get: (r) => r.finalTotalMB },
    { metric: 'peakPrivateMB', label: '峰值专用提交', unit: 'MB', get: (r) => r.peakPrivateMB },
    { metric: 'peakCpu', label: 'CPU 峰值', unit: '%', get: (r) => r.peakCpu },
    { metric: 'peakVram', label: '显存峰值', unit: 'MB', get: (r) => r.peakVram },
    { metric: 'peakGpu', label: 'GPU 引擎峰值', unit: '%', get: (r) => r.peakGpu },
  ]

  return defs
    .map((d) => {
      const nums = active.map(d.get).filter((v): v is number => v != null && !Number.isNaN(v))
      if (nums.length === 0) return null
      return {
        metric: d.metric,
        label: d.label,
        unit: d.unit,
        min: Math.min(...nums),
        max: Math.max(...nums),
        median: Math.round(median(nums) * 10) / 10,
        mean: Math.round(mean(nums) * 10) / 10,
        stdDev: Math.round(stdDev(nums) * 10) / 10,
        sampleCount: nums.length,
      }
    })
    .filter((x): x is BaselineMetricStat => x != null)
}
