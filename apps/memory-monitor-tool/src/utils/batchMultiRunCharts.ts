import type { MemorySnapshot, ReportEventMark, ReportSummary } from '../types'
import { getEffectiveMemoryKB } from './format'
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
  pct: number
  [key: string]: number | string | null
}

export interface BatchMarkAtPct {
  pct: number
  label: string
  sessionId: string
  sessionLabel: string
}

const RUN_COLORS = [
  '#646cff', '#fa8c16', '#52c41a', '#eb2f96', '#13c2c2',
  '#f5a623', '#ff6b6b', '#2f54eb', '#a0d911', '#9254de',
]

const PCT_BUCKETS = 101

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

function resampleToPct(values: number[]): number[] {
  if (values.length === 0) return Array(PCT_BUCKETS).fill(0)
  if (values.length === 1) return Array(PCT_BUCKETS).fill(values[0]!)
  const out: number[] = []
  for (let pct = 0; pct < PCT_BUCKETS; pct++) {
    const pos = (pct / 100) * (values.length - 1)
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    const t = pos - lo
    const a = values[lo] ?? 0
    const b = values[hi] ?? a
    out.push(Math.round((a + (b - a) * t) * 10) / 10)
  }
  return out
}

function buildPctPoints(
  runs: BatchRunLoaded[],
  valueFn: (run: BatchRunLoaded) => number[],
): { points: BatchMultiRunPoint[]; series: BatchSeriesMeta[] } {
  const series: BatchSeriesMeta[] = runs.map((r, i) => ({
    key: runSeriesKey(r.sessionId),
    label: chartLegendLabel(r.label),
    color: RUN_COLORS[i % RUN_COLORS.length]!,
  }))

  const resampled = runs.map((r) => resampleToPct(valueFn(r)))
  const points: BatchMultiRunPoint[] = []
  for (let pct = 0; pct < PCT_BUCKETS; pct++) {
    const row: BatchMultiRunPoint = { pct }
    runs.forEach((r, ri) => {
      row[runSeriesKey(r.sessionId)] = resampled[ri]![pct] ?? null
    })
    points.push(row)
  }
  return { points, series }
}

export function buildBatchAggregateMemoryPoints(runs: BatchRunLoaded[]) {
  return buildPctPoints(runs, (r) => seriesForSelection(r.snapshots, 'aggregate'))
}

export function buildBatchProcessMemoryPoints(
  runs: BatchRunLoaded[],
  identityKey: ComparePidSelection,
) {
  return buildPctPoints(runs, (r) => seriesForSelection(r.snapshots, identityKey))
}

export type BatchResourceMetric = 'cpu' | 'diskRead' | 'diskWrite' | 'gpu' | 'vram'

function resourceSeriesFromReport(report: ReportSummary, metric: BatchResourceMetric): number[] {
  const pts = report.dataPoints.filter((p) => p.extCpuPercent !== undefined)
  if (pts.length === 0) return []
  return pts.map((p) => {
    switch (metric) {
      case 'cpu': return Math.round((p.extCpuPercent ?? 0) * 100) / 100
      case 'diskRead': return Math.round((p.extDiskReadKBps ?? 0) * 100) / 100
      case 'diskWrite': return Math.round((p.extDiskWriteKBps ?? 0) * 100) / 100
      case 'gpu':
        return p.extGpuEnginePercent != null ? Math.round(p.extGpuEnginePercent * 10) / 10 : 0
      case 'vram':
        return p.extGpuDedicatedMB != null ? Math.round(p.extGpuDedicatedMB * 10) / 10 : 0
      default: return 0
    }
  })
}

export function buildBatchResourcePoints(runs: BatchRunLoaded[], metric: BatchResourceMetric) {
  return buildPctPoints(runs, (r) => resourceSeriesFromReport(r.report, metric))
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

export function collectBatchMarkRefs(runs: BatchRunLoaded[]): BatchMarkAtPct[] {
  const out: BatchMarkAtPct[] = []
  for (const r of runs) {
    if (r.snapshots.length < 2) continue
    const t0 = r.snapshots[0]!.timestamp
    const t1 = r.snapshots[r.snapshots.length - 1]!.timestamp
    const dur = t1 - t0 || 1
    for (const m of r.marks) {
      const pct = Math.max(0, Math.min(100, Math.round(((m.timestamp - t0) / dur) * 1000) / 10))
      out.push({
        pct,
        label: m.label,
        sessionId: r.sessionId,
        sessionLabel: r.label,
      })
    }
  }
  return out.sort((a, b) => a.pct - b.pct || a.sessionLabel.localeCompare(b.sessionLabel))
}
