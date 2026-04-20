/**
 * 从快照展平事件标记并附上该采样点的分类内存（与 SDK Analyzer.collectEventMarks 口径一致）
 */
import type { MemorySnapshot, ReportEventMark } from '../types'
import { getEffectiveMemoryKB } from './format'

export function collectReportEventMarksFromSnapshots(snapshots: MemorySnapshot[]): ReportEventMark[] {
  const out: ReportEventMark[] = []
  for (const s of snapshots) {
    if (!s.marks?.length) continue
    const browserKB = s.processes
      .filter((p) => p.type === 'Browser')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const rendererKB = s.processes
      .filter((p) => p.type === 'Tab')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    const gpuKB = s.processes
      .filter((p) => p.type === 'GPU')
      .reduce((sum, p) => sum + getEffectiveMemoryKB(p.memory), 0)
    for (const m of s.marks) {
      out.push({
        timestamp: m.timestamp,
        label: m.label,
        metadata: m.metadata,
        totalWorkingSetKB: s.totalWorkingSetSize,
        browserKB,
        rendererKB,
        gpuKB,
      })
    }
  }
  return out
}

/** 标记落在第几号快照上（用于对比页按「采样序号」对齐）；找不到则按时间最近邻 */
export function snapshotIndexForMark(
  snapshots: MemorySnapshot[],
  mark: { timestamp: number; label: string },
): number {
  if (snapshots.length === 0) return 0
  for (let i = 0; i < snapshots.length; i++) {
    const ms = snapshots[i].marks
    if (!ms?.length) continue
    if (ms.some((m) => m.timestamp === mark.timestamp && m.label === mark.label)) return i
  }
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < snapshots.length; i++) {
    const d = Math.abs(snapshots[i].timestamp - mark.timestamp)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
