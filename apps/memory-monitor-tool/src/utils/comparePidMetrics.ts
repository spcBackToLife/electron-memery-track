import type { MemorySnapshot, ProcessMemoryInfo } from '../types'
import { getEffectiveMemoryKB } from './format'

/** 会话合计，或某条「进程身份」曲线（按命令行 / 镜像路径 / 名称聚合，非裸 PID） */
export type ComparePidSelection = 'aggregate' | string

export interface PidCompareRow {
  /** 内部稳定键（cmd:/exe:/name:/pid: 前缀） */
  identityKey: string
  /** 展示用短标题 */
  label: string
  /** 镜像路径或命令行摘要，供 tooltip */
  detail?: string
  peakBaseMB: number
  peakTargetMB: number
  peakDiffMB: number
  /** 基线为 0 且目标有值时无意义，为 null */
  peakChangePercent: number | null
  avgBaseMB: number
  avgTargetMB: number
  avgDiffMB: number
  avgChangePercent: number | null
  finalBaseMB: number
  finalTargetMB: number
  finalDiffMB: number
}

function procMemMB(p: ProcessMemoryInfo | undefined): number {
  if (!p) return 0
  return Math.round((getEffectiveMemoryKB(p.memory) / 1024) * 10) / 10
}

/** 归一化镜像路径，便于跨会话匹配 */
function stableExeKey(raw: string | undefined): string | null {
  const t = raw?.trim()
  if (!t) return null
  return t.replace(/\//g, '\\').toLowerCase()
}

/** 归一化命令行（跨会话 PID 会变，命令行更贴近「同一启动方式」） */
function stableCmdKey(raw: string | undefined): string | null {
  const t = raw?.trim()
  if (!t) return null
  return t.replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 单进程在单次快照中的对比身份：
 * 1) 有 CommandLine → 按命令行
 * 2) 否则有 ExecutablePath → 按镜像路径
 * 3) 外部模式有进程名 → 按名称（弱匹配，多实例会合并）
 * 4) 否则按 PID（自监控或缺字段）
 */
export function identityKeyForProc(p: ProcessMemoryInfo, sn: MemorySnapshot): string {
  const cmdK = stableCmdKey(p.commandLine)
  if (cmdK) return `cmd:${cmdK}`
  const exeK = stableExeKey(p.executablePath)
  if (exeK) return `exe:${exeK}`
  if (sn.monitorMode === 'external' && p.name?.trim()) return `name:${p.name.trim().toLowerCase()}`
  return `pid:${p.pid}`
}

function memSumByIdentity(sn: MemorySnapshot, key: string): number {
  let kb = 0
  for (const p of sn.processes) {
    if (identityKeyForProc(p, sn) === key) kb += getEffectiveMemoryKB(p.memory)
  }
  return Math.round((kb / 1024) * 10) / 10
}

function collectUnionIdentityKeys(base: MemorySnapshot[], target: MemorySnapshot[], n: number): string[] {
  const set = new Set<string>()
  for (let i = 0; i < n; i++) {
    for (const p of base[i]!.processes) set.add(identityKeyForProc(p, base[i]!))
    for (const p of target[i]!.processes) set.add(identityKeyForProc(p, target[i]!))
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

function inferLabelAndDetail(
  key: string,
  base: MemorySnapshot[],
  target: MemorySnapshot[],
): { label: string; detail?: string } {
  const pickProc = (): ProcessMemoryInfo | undefined => {
    for (let i = target.length - 1; i >= 0; i--) {
      for (const p of target[i]!.processes) {
        if (identityKeyForProc(p, target[i]!) === key) return p
      }
    }
    for (let i = base.length - 1; i >= 0; i--) {
      for (const p of base[i]!.processes) {
        if (identityKeyForProc(p, base[i]!) === key) return p
      }
    }
    return undefined
  }
  const p = pickProc()
  if (key.startsWith('cmd:')) {
    const cmd = p?.commandLine?.trim() || key.slice(4)
    const short = cmd.length > 72 ? `${cmd.slice(0, 70)}…` : cmd
    return { label: p?.name?.trim() || '命令行进程', detail: cmd }
  }
  if (key.startsWith('exe:')) {
    const path = p?.executablePath?.trim() || key.slice(4)
    const baseName = path.split(/[/\\]/).pop() || path
    return { label: baseName, detail: path }
  }
  if (key.startsWith('name:')) {
    return { label: key.slice(5) }
  }
  const pid = Number(key.slice(4))
  return { label: Number.isFinite(pid) ? `PID ${pid}` : key }
}

function seriesForIdentity(snaps: MemorySnapshot[], n: number, key: string): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(memSumByIdentity(snaps[i]!, key))
  }
  return out
}

function seriesAggregate(snaps: MemorySnapshot[], n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(Math.round((snaps[i]!.totalWorkingSetSize / 1024) * 10) / 10)
  }
  return out
}

function statsFromSeries(s: number[]): { peak: number; avg: number; final: number } {
  if (s.length === 0) return { peak: 0, avg: 0, final: 0 }
  const peak = Math.max(...s)
  const sum = s.reduce((a, b) => a + b, 0)
  const avg = Math.round((sum / s.length) * 10) / 10
  const final = s[s.length - 1]!
  return { peak, avg, final }
}

function pctOrNull(base: number, diff: number): number | null {
  if (base > 0) return Math.round((diff / base) * 10000) / 100
  if (base === 0 && diff !== 0) return null
  return 0
}

function diffStats(
  bs: { peak: number; avg: number; final: number },
  ts: { peak: number; avg: number; final: number },
): Pick<
  PidCompareRow,
  'peakDiffMB' | 'peakChangePercent' | 'avgDiffMB' | 'avgChangePercent' | 'finalDiffMB'
> {
  const peakDiffMB = Math.round((ts.peak - bs.peak) * 10) / 10
  const avgDiffMB = Math.round((ts.avg - bs.avg) * 10) / 10
  const finalDiffMB = Math.round((ts.final - bs.final) * 10) / 10
  return {
    peakDiffMB,
    peakChangePercent: pctOrNull(bs.peak, peakDiffMB),
    avgDiffMB,
    avgChangePercent: pctOrNull(bs.avg, avgDiffMB),
    finalDiffMB,
  }
}

/** 对齐两会话快照后，按「命令行 / 镜像路径 / 名称 / PID」聚合再算峰值、均值、末值 */
export function computePidCompareTable(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
): PidCompareRow[] {
  const n = Math.min(base.length, target.length)
  if (n === 0) return []

  const keys = collectUnionIdentityKeys(base, target, n)
  const rows: PidCompareRow[] = []

  for (const identityKey of keys) {
    const bS = seriesForIdentity(base, n, identityKey)
    const tS = seriesForIdentity(target, n, identityKey)
    const bs = statsFromSeries(bS)
    const ts = statsFromSeries(tS)
    const d = diffStats(bs, ts)
    const { label, detail } = inferLabelAndDetail(identityKey, base, target)
    rows.push({
      identityKey,
      label,
      detail,
      peakBaseMB: bs.peak,
      peakTargetMB: ts.peak,
      avgBaseMB: bs.avg,
      avgTargetMB: ts.avg,
      finalBaseMB: bs.final,
      finalTargetMB: ts.final,
      ...d,
    })
  }

  rows.sort((a, b) => Math.max(b.peakBaseMB, b.peakTargetMB) - Math.max(a.peakBaseMB, a.peakTargetMB))
  return rows
}

export interface CompareTrendPoint {
  index: number
  baseMB: number
  targetMB: number
}

export function buildCompareTrendPoints(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
  selection: ComparePidSelection,
): CompareTrendPoint[] {
  const n = Math.min(base.length, target.length)
  if (n < 2) return []

  const bS =
    selection === 'aggregate'
      ? seriesAggregate(base, n)
      : seriesForIdentity(base, n, selection)
  const tS =
    selection === 'aggregate'
      ? seriesAggregate(target, n)
      : seriesForIdentity(target, n, selection)

  const merged: CompareTrendPoint[] = []
  for (let i = 0; i < n; i++) {
    merged.push({ index: i, baseMB: bS[i]!, targetMB: tS[i]! })
  }
  return merged
}

export function getSelectionMetricsRow(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
  selection: ComparePidSelection,
): PidCompareRow | null {
  const n = Math.min(base.length, target.length)
  if (n === 0) return null

  if (selection === 'aggregate') {
    const bS = seriesAggregate(base, n)
    const tS = seriesAggregate(target, n)
    const bs = statsFromSeries(bS)
    const ts = statsFromSeries(tS)
    const d = diffStats(bs, ts)
    return {
      identityKey: 'aggregate',
      label: '会话合计（全部 PID）',
      peakBaseMB: bs.peak,
      peakTargetMB: ts.peak,
      avgBaseMB: bs.avg,
      avgTargetMB: ts.avg,
      finalBaseMB: bs.final,
      finalTargetMB: ts.final,
      ...d,
    }
  }

  const bS = seriesForIdentity(base, n, selection)
  const tS = seriesForIdentity(target, n, selection)
  const bs = statsFromSeries(bS)
  const ts = statsFromSeries(tS)
  const d = diffStats(bs, ts)
  const { label, detail } = inferLabelAndDetail(selection, base, target)
  return {
    identityKey: selection,
    label,
    detail,
    peakBaseMB: bs.peak,
    peakTargetMB: ts.peak,
    avgBaseMB: bs.avg,
    avgTargetMB: ts.avg,
    finalBaseMB: bs.final,
    finalTargetMB: ts.final,
    ...d,
  }
}
