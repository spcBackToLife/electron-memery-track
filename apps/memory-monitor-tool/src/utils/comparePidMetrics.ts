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

function collectAppearingIdentityKeys(snaps: MemorySnapshot[], n: number): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < n; i++) {
    for (const p of snaps[i]!.processes) {
      set.add(identityKeyForProc(p, snaps[i]!))
    }
  }
  return set
}

function hadPositiveMemoryInWindow(snaps: MemorySnapshot[], n: number, key: string): boolean {
  for (let i = 0; i < n; i++) {
    if (memSumByIdentity(snaps[i]!, key) > 0) return true
  }
  return false
}

/** 两侧都曾以该身份出现，且各自窗口内至少一拍上该身份内存合计 > 0 */
function collectIntersectingIdentityKeys(base: MemorySnapshot[], target: MemorySnapshot[], n: number): string[] {
  const baseKeys = collectAppearingIdentityKeys(base, n)
  const targetKeys = collectAppearingIdentityKeys(target, n)
  const out: string[] = []
  for (const k of baseKeys) {
    if (!targetKeys.has(k)) continue
    if (!hadPositiveMemoryInWindow(base, n, k)) continue
    if (!hadPositiveMemoryInWindow(target, n, k)) continue
    out.push(k)
  }
  return out.sort((a, b) => a.localeCompare(b))
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

/**
 * 对齐两会话快照后，按「命令行 / 镜像路径 / 名称 / PID」聚合再算峰值、均值、末值。
 * 仅包含两侧窗口内都曾出现、且各自至少一拍上该身份内存合计 > 0 的键（不做进程名单或 MB 阈值特例）。
 */
export function computePidCompareTable(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
): PidCompareRow[] {
  const n = Math.min(base.length, target.length)
  if (n === 0) return []

  const keys = collectIntersectingIdentityKeys(base, target, n)
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

/** 按采样序号对齐后的外部资源（CPU / 磁盘 / GPU）；缺字段按 0 或 null */
export interface CompareResourcePoint {
  index: number
  baseCpu: number
  targetCpu: number
  baseDiskRead: number
  targetDiskRead: number
  baseDiskWrite: number
  targetDiskWrite: number
  baseGpu: number | null
  targetGpu: number | null
  baseVram: number | null
  targetVram: number | null
}

export function buildCompareResourcePoints(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
): CompareResourcePoint[] {
  const n = Math.min(base.length, target.length)
  if (n < 2) return []
  const out: CompareResourcePoint[] = []
  for (let i = 0; i < n; i++) {
    const b = base[i]!.externalMetrics
    const t = target[i]!.externalMetrics
    out.push({
      index: i,
      baseCpu: Math.round((b?.aggregateCpuPercent ?? 0) * 100) / 100,
      targetCpu: Math.round((t?.aggregateCpuPercent ?? 0) * 100) / 100,
      baseDiskRead: Math.round((b?.diskReadKBps ?? 0) * 100) / 100,
      targetDiskRead: Math.round((t?.diskReadKBps ?? 0) * 100) / 100,
      baseDiskWrite: Math.round((b?.diskWriteKBps ?? 0) * 100) / 100,
      targetDiskWrite: Math.round((t?.diskWriteKBps ?? 0) * 100) / 100,
      baseGpu: b?.gpuEnginePercent != null ? Math.round(b.gpuEnginePercent * 10) / 10 : null,
      targetGpu: t?.gpuEnginePercent != null ? Math.round(t.gpuEnginePercent * 10) / 10 : null,
      baseVram: b?.gpuDedicatedMB != null ? Math.round(b.gpuDedicatedMB * 10) / 10 : null,
      targetVram: t?.gpuDedicatedMB != null ? Math.round(t.gpuDedicatedMB * 10) / 10 : null,
    })
  }
  return out
}

/** 至少一侧快照带 externalMetrics 且对齐点数 ≥2 */
export function hasCompareResourceSeries(base: MemorySnapshot[], target: MemorySnapshot[]): boolean {
  const n = Math.min(base.length, target.length)
  if (n < 2) return false
  for (let i = 0; i < n; i++) {
    if (base[i]!.externalMetrics != null || target[i]!.externalMetrics != null) return true
  }
  return false
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

/** 会话级外部资源（CPU/磁盘/GPU）数值对比行，与「会话合计」内存表同一套列 */
export interface ExternalResourceCompareFlatRow {
  label: string
  base: number | null
  target: number | null
  diff: number | null
  changePercent: number | null
}

function externalCpuSeries(snaps: MemorySnapshot[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => snaps[i]!.externalMetrics?.aggregateCpuPercent ?? 0)
}

function externalDiskReadSeries(snaps: MemorySnapshot[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => snaps[i]!.externalMetrics?.diskReadKBps ?? 0)
}

function externalDiskWriteSeries(snaps: MemorySnapshot[], n: number): number[] {
  return Array.from({ length: n }, (_, i) => snaps[i]!.externalMetrics?.diskWriteKBps ?? 0)
}

function externalGpuSeries(snaps: MemorySnapshot[], n: number): (number | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const v = snaps[i]!.externalMetrics?.gpuEnginePercent
    if (v == null || Number.isNaN(v)) return null
    return v
  })
}

function externalVramSeries(snaps: MemorySnapshot[], n: number): (number | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const v = snaps[i]!.externalMetrics?.gpuDedicatedMB
    if (v == null || Number.isNaN(v)) return null
    return v
  })
}

function statsTripleNullable(s: (number | null)[]): { peak: number | null; avg: number | null; final: number | null } {
  const nums = s.filter((x): x is number => x != null && !Number.isNaN(x))
  const lastRaw = s[s.length - 1]
  const final =
    lastRaw != null && !Number.isNaN(lastRaw) ? Math.round(lastRaw * 10) / 10 : null
  if (nums.length === 0) return { peak: null, avg: null, final }
  return {
    peak: Math.round(Math.max(...nums) * 10) / 10,
    avg: Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10,
    final,
  }
}

function diffScalarPair(
  base: number | null,
  target: number | null,
): { diff: number | null; changePercent: number | null } {
  if (base == null || target == null) return { diff: null, changePercent: null }
  const diff = Math.round((target - base) * 10) / 10
  return { diff, changePercent: pctOrNull(base, diff) }
}

function pushTripleRows(
  out: ExternalResourceCompareFlatRow[],
  title: string,
  unit: string,
  bs: { peak: number; avg: number; final: number },
  ts: { peak: number; avg: number; final: number },
): void {
  const mk = (suffix: string, b: number, t: number) => {
    const { diff, changePercent } = diffScalarPair(b, t)
    out.push({
      label: `${suffix} ${title} (${unit})`,
      base: b,
      target: t,
      diff,
      changePercent,
    })
  }
  mk('峰值', bs.peak, ts.peak)
  mk('平均', bs.avg, ts.avg)
  mk('末值', bs.final, ts.final)
}

function pushTripleRowsNullable(
  out: ExternalResourceCompareFlatRow[],
  title: string,
  unit: string,
  bs: { peak: number | null; avg: number | null; final: number | null },
  ts: { peak: number | null; avg: number | null; final: number | null },
): void {
  const mk = (suffix: string, b: number | null, t: number | null) => {
    const { diff, changePercent } = diffScalarPair(b, t)
    out.push({
      label: `${suffix} ${title} (${unit})`,
      base: b,
      target: t,
      diff,
      changePercent,
    })
  }
  mk('峰值', bs.peak, ts.peak)
  mk('平均', bs.avg, ts.avg)
  mk('末值', bs.final, ts.final)
}

/**
 * 对齐两会话快照后，对比子树 CPU/磁盘与 GPU（PDH 子树 PID 汇总；仅会话级指标，与分进程内存选择无关）。
 */
export function computeExternalResourceCompareRows(
  base: MemorySnapshot[],
  target: MemorySnapshot[],
): ExternalResourceCompareFlatRow[] {
  const n = Math.min(base.length, target.length)
  if (n < 1) return []
  if (!hasCompareResourceSeries(base, target)) return []

  const bCpu = statsFromSeries(externalCpuSeries(base, n))
  const tCpu = statsFromSeries(externalCpuSeries(target, n))
  const bRead = statsFromSeries(externalDiskReadSeries(base, n))
  const tRead = statsFromSeries(externalDiskReadSeries(target, n))
  const bWrite = statsFromSeries(externalDiskWriteSeries(base, n))
  const tWrite = statsFromSeries(externalDiskWriteSeries(target, n))
  const bGpu = statsTripleNullable(externalGpuSeries(base, n))
  const tGpu = statsTripleNullable(externalGpuSeries(target, n))
  const bVram = statsTripleNullable(externalVramSeries(base, n))
  const tVram = statsTripleNullable(externalVramSeries(target, n))

  const out: ExternalResourceCompareFlatRow[] = []
  pushTripleRows(out, 'CPU', '%', bCpu, tCpu)
  pushTripleRows(out, '磁盘读取', 'KB/s', bRead, tRead)
  pushTripleRows(out, '磁盘写入', 'KB/s', bWrite, tWrite)
  pushTripleRowsNullable(out, 'GPU 引擎', '%', bGpu, tGpu)
  pushTripleRowsNullable(out, 'GPU 显存', 'MB', bVram, tVram)
  return out
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
