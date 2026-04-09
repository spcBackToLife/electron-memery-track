import type { MemorySnapshot } from '../../types/snapshot'
import type { SessionEventMark } from '../../types/report'

/** 与 Analyzer.collectEventMark 一致，供 UI 在旧版 report.json 无 eventMarks 时兜底展示 */
export function eventMarksFromSnapshots(snapshots: MemorySnapshot[]): SessionEventMark[] {
  const out: SessionEventMark[] = []
  for (const s of snapshots) {
    if (!s.marks?.length) continue
    const browserKB = s.processes
      .filter((p) => p.type === 'Browser')
      .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    const rendererKB = s.processes
      .filter((p) => p.type === 'Tab' && !p.isMonitorProcess)
      .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    const gpuKB = s.processes
      .filter((p) => p.type === 'GPU')
      .reduce((sum, p) => sum + p.memory.workingSetSize, 0)
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
