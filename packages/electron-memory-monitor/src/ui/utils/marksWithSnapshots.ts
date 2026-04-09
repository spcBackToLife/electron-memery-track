import type { MemorySnapshot, EventMark } from '../../types/snapshot'

/** 单个标记与其所在完整快照（用于对比图与详情面板） */
export interface MarkWithSnapshot {
  key: string
  mark: EventMark
  snapshot: MemorySnapshot
}

/** 按时间顺序展平：同一条快照上的多个 mark 各对应同一份 snapshot（内存相同、标签不同） */
export function listMarksWithSnapshots(snapshots: MemorySnapshot[]): MarkWithSnapshot[] {
  const out: MarkWithSnapshot[] = []
  let idx = 0
  for (const s of snapshots) {
    if (!s.marks?.length) continue
    for (const m of s.marks) {
      idx += 1
      out.push({
        key: `m-${m.timestamp}-${idx}-${m.label.slice(0, 24)}`,
        mark: m,
        snapshot: s,
      })
    }
  }
  out.sort((a, b) => a.mark.timestamp - b.mark.timestamp)
  return out
}
