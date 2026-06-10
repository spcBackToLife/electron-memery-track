import type { MemorySnapshot, ReportEventMark, ReportSummary } from '../types'
import { getEffectiveMemoryKB } from './format'
import { collectReportEventMarksFromSnapshots } from './reportEventMarks'
import type { ComparePidSelection } from './comparePidMetrics'
import {
  describeProcessIdentity,
  identityKeyForProc,
  pickRepresentativeProc,
  type ProcessIdentityDisplay,
} from './processIdentity'

export interface BatchRunLoaded {
  sessionId: string
  runIndex: number
  label: string
  shortLabel: string
  report: ReportSummary
  snapshots: MemorySnapshot[]
  marks: ReportEventMark[]
}

export interface BatchSeriesMeta {
  key: string
  label: string
  color: string
}

export interface BatchMultiRunPoint {
  /** 会话开始后经过的秒数（与各轮快照、mark 的 timestamp 同源） */
  elapsedSec: number
  [key: string]: number | string | null
}

export interface BatchMarkRef {
  /** 该会话内 mark 发生时刻：相对会话开始的秒数 */
  elapsedSec: number
  label: string
  sessionId: string
  sessionLabel: string
}

const RUN_COLORS = [
  '#646cff', '#fa8c16', '#52c41a', '#eb2f96', '#13c2c2',
  '#f5a623', '#ff6b6b', '#2f54eb', '#a0d911', '#9254de',
]

/** 折线图 dataKey（用 sessionId，排除轮次后仍唯一） */
export function runSeriesKey(sessionId: string): string {
  return `sid_${sessionId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

/** 图例展示：优先完整会话名，过长则截断 */
export function chartLegendLabel(sessionLabel: string): string {
  const t = sessionLabel.trim()
  if (t.length <= 56) return t
  return `${t.slice(0, 54)}…`
}

/** 横轴刻度：与会话内经过时间一致 */
export function formatElapsedAxis(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s'
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function sessionStartTs(run: BatchRunLoaded): number {
  if (run.snapshots.length > 0) return run.snapshots[0]!.timestamp
  return run.report.startTime
}

function elapsedSecFromTs(t0: number, ts: number): number {
  return Math.round(((ts - t0) / 1000) * 10) / 10
}

function memSumByIdentity(sn: MemorySnapshot, key: string): number {
  let kb = 0
  for (const p of sn.processes) {
    if (identityKeyForProc(p, sn) === key) kb += getEffectiveMemoryKB(p.memory)
  }
  return Math.round((kb / 1024) * 10) / 10
}

function seriesForSelection(snaps: MemorySnapshot[], selection: ComparePidSelection): number[] {
  if (snaps.length === 0) return []
  if (selection === 'aggregate') {
    return snaps.map((s) => Math.round((s.totalWorkingSetSize / 1024) * 10) / 10)
  }
  return snaps.map((s) => memSumByIdentity(s, selection))
}

interface TimeValuePoint {
  t: number
  v: number
}

function buildTimeValueSeries(run: BatchRunLoaded, values: number[]): TimeValuePoint[] {
  const t0 = sessionStartTs(run)
  return run.snapshots.map((s, i) => ({
    t: elapsedSecFromTs(t0, s.timestamp),
    v: values[i] ?? 0,
  }))
}

function interpolateAt(series: TimeValuePoint[], t: number): number | null {
  if (series.length === 0) return null
  if (t < series[0]!.t || t > series[series.length - 1]!.t) return null
  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i]!
    const b = series[i + 1]!
    if (t >= a.t && t <= b.t) {
      if (b.t === a.t) return a.v
      const ratio = (t - a.t) / (b.t - a.t)
      return Math.round((a.v + (b.v - a.v) * ratio) * 10) / 10
    }
  }
  return series[series.length - 1]!.v
}

function maxElapsedSec(runs: BatchRunLoaded[]): number {
  let max = 0
  for (const r of runs) {
    if (r.snapshots.length < 2) {
      max = Math.max(max, r.report.durationMs / 1000)
      continue
    }
    const t0 = sessionStartTs(r)
    const end = r.snapshots[r.snapshots.length - 1]!.timestamp
    max = Math.max(max, (end - t0) / 1000)
  }
  return Math.max(1, max)
}

function buildTimeGrid(maxSec: number): number[] {
  const step = maxSec > 300 ? 5 : maxSec > 120 ? 2 : 1
  const count = Math.min(400, Math.max(40, Math.ceil(maxSec / step)))
  const out: number[] = []
  for (let i = 0; i <= count; i++) {
    out.push(Math.round((i / count) * maxSec * 10) / 10)
  }
  return out
}

function buildElapsedPoints(
  runs: BatchRunLoaded[],
  valueFn: (run: BatchRunLoaded) => number[],
): { points: BatchMultiRunPoint[]; series: BatchSeriesMeta[]; maxElapsedSec: number } {
  const series: BatchSeriesMeta[] = runs.map((r, i) => ({
    key: runSeriesKey(r.sessionId),
    label: chartLegendLabel(r.label),
    color: RUN_COLORS[i % RUN_COLORS.length]!,
  }))

  const maxSec = maxElapsedSec(runs)
  const grid = buildTimeGrid(maxSec)
  const runSeries = runs.map((r) => buildTimeValueSeries(r, valueFn(r)))

  const points: BatchMultiRunPoint[] = grid.map((elapsedSec) => {
    const row: BatchMultiRunPoint = { elapsedSec }
    runs.forEach((r, ri) => {
      row[runSeriesKey(r.sessionId)] = interpolateAt(runSeries[ri]!, elapsedSec)
    })
    return row
  })

  return { points, series, maxElapsedSec: maxSec }
}

export function buildBatchAggregateMemoryPoints(runs: BatchRunLoaded[]) {
  return buildElapsedPoints(runs, (r) => seriesForSelection(r.snapshots, 'aggregate'))
}

export function buildBatchProcessMemoryPoints(
  runs: BatchRunLoaded[],
  identityKey: ComparePidSelection,
) {
  return buildElapsedPoints(runs, (r) => seriesForSelection(r.snapshots, identityKey))
}

export type BatchResourceMetric = 'cpu' | 'diskRead' | 'diskWrite' | 'gpu' | 'vram'

function resourceTimeSeries(run: BatchRunLoaded, metric: BatchResourceMetric): TimeValuePoint[] {
  const pts = run.report.dataPoints.filter((p) => p.extCpuPercent !== undefined)
  if (pts.length === 0) return []
  const t0 = pts[0]!.timestamp
  return pts.map((p) => {
    let v = 0
    switch (metric) {
      case 'cpu': v = Math.round((p.extCpuPercent ?? 0) * 100) / 100; break
      case 'diskRead': v = Math.round((p.extDiskReadKBps ?? 0) * 100) / 100; break
      case 'diskWrite': v = Math.round((p.extDiskWriteKBps ?? 0) * 100) / 100; break
      case 'gpu':
        v = p.extGpuEnginePercent != null ? Math.round(p.extGpuEnginePercent * 10) / 10 : 0
        break
      case 'vram':
        v = p.extGpuDedicatedMB != null ? Math.round(p.extGpuDedicatedMB * 10) / 10 : 0
        break
      default: v = 0
    }
    return { t: elapsedSecFromTs(t0, p.timestamp), v }
  })
}

export function buildBatchResourcePoints(runs: BatchRunLoaded[], metric: BatchResourceMetric) {
  const series: BatchSeriesMeta[] = runs.map((r, i) => ({
    key: runSeriesKey(r.sessionId),
    label: chartLegendLabel(r.label),
    color: RUN_COLORS[i % RUN_COLORS.length]!,
  }))

  const maxSec = Math.max(
    1,
    ...runs.map((r) => {
      const s = resourceTimeSeries(r, metric)
      return s.length > 0 ? s[s.length - 1]!.t : r.report.durationMs / 1000
    }),
  )
  const grid = buildTimeGrid(maxSec)
  const runSeries = runs.map((r) => resourceTimeSeries(r, metric))

  const points: BatchMultiRunPoint[] = grid.map((elapsedSec) => {
    const row: BatchMultiRunPoint = { elapsedSec }
    runs.forEach((r, ri) => {
      row[runSeriesKey(r.sessionId)] = interpolateAt(runSeries[ri]!, elapsedSec)
    })
    return row
  })

  return { points, series, maxElapsedSec: maxSec }
}

export function hasBatchResourceData(runs: BatchRunLoaded[]): boolean {
  return runs.some((r) => r.report.dataPoints.some((p) => p.extCpuPercent !== undefined))
}

function runHasPositiveMemoryForKey(run: BatchRunLoaded, key: string): boolean {
  for (const sn of run.snapshots) {
    for (const p of sn.processes) {
      if (identityKeyForProc(p, sn) !== key) continue
      if (getEffectiveMemoryKB(p.memory) > 0) return true
    }
  }
  return false
}

export function collectBatchProcessOptions(runs: BatchRunLoaded[]): ProcessIdentityDisplay[] {
  const peakByKey = new Map<string, number>()
  const coverageByKey = new Map<string, number>()

  for (const r of runs) {
    const keysInRun = new Set<string>()
    for (const sn of r.snapshots) {
      for (const p of sn.processes) {
        const k = identityKeyForProc(p, sn)
        const mb = getEffectiveMemoryKB(p.memory) / 1024
        peakByKey.set(k, Math.max(peakByKey.get(k) ?? 0, mb))
        keysInRun.add(k)
      }
    }
    for (const k of keysInRun) {
      if (runHasPositiveMemoryForKey(r, k)) {
        coverageByKey.set(k, (coverageByKey.get(k) ?? 0) + 1)
      }
    }
  }

  const totalRuns = runs.length
  return [...peakByKey.entries()]
    .map(([identityKey, peakMB]) => {
      const proc = pickRepresentativeProc(runs, identityKey)
      const runCoverage = coverageByKey.get(identityKey) ?? 0
      return describeProcessIdentity(identityKey, proc, peakMB, runCoverage, totalRuns)
    })
    .sort((a, b) => {
      if (b.runCoverage !== a.runCoverage) return b.runCoverage - a.runCoverage
      return b.peakMB - a.peakMB
    })
}

function marksForRun(run: BatchRunLoaded): ReportEventMark[] {
  if (run.marks.length > 0) return run.marks
  return collectReportEventMarksFromSnapshots(run.snapshots)
}

/** mark 的 timestamp 与会话快照同源 → 相对会话开始的秒数（与单次报告竖线一致） */
function markElapsedSec(run: BatchRunLoaded, mark: { timestamp: number }): number {
  const t0 = sessionStartTs(run)
  return elapsedSecFromTs(t0, mark.timestamp)
}

export function collectBatchMarkRefs(runs: BatchRunLoaded[]): BatchMarkRef[] {
  const out: BatchMarkRef[] = []
  for (const r of runs) {
    if (r.snapshots.length < 1 && r.marks.length === 0) continue
    for (const m of marksForRun(r)) {
      out.push({
        elapsedSec: markElapsedSec(r, m),
        label: m.label,
        sessionId: r.sessionId,
        sessionLabel: r.label,
      })
    }
  }
  return out.sort((a, b) => a.elapsedSec - b.elapsedSec || a.sessionLabel.localeCompare(b.sessionLabel))
}
