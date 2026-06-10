import type { TestSession } from '../types'

/** 自动化批跑 label：`{prefix}-{appName}-run{N}-{YYYY-MM-DD-HH-MM-SS}` */
const BATCH_LABEL_RE = /^(.+)-run(\d+)-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})$/

export interface BatchRunMeta {
  sessionId: string
  label: string
  runIndex: number | null
  startTime: number
  endTime?: number
  snapshotCount: number
}

export interface BatchGroup {
  batchKey: string
  prefix: string
  appName: string
  runs: BatchRunMeta[]
}

export function parseBatchRunLabel(label: string): { batchKey: string; runIndex: number } | null {
  const m = label.match(BATCH_LABEL_RE)
  if (!m) return null
  return { batchKey: m[1]!, runIndex: Number(m[2]) }
}

export function groupSessionsIntoBatches(sessions: TestSession[]): BatchGroup[] {
  const map = new Map<string, BatchRunMeta[]>()

  for (const s of sessions) {
    if (s.status !== 'completed') continue
    const parsed = parseBatchRunLabel(s.label)
    const batchKey = parsed?.batchKey ?? s.label
    const run: BatchRunMeta = {
      sessionId: s.id,
      label: s.label,
      runIndex: parsed?.runIndex ?? null,
      startTime: s.startTime,
      endTime: s.endTime,
      snapshotCount: s.snapshotCount,
    }
    if (!map.has(batchKey)) map.set(batchKey, [])
    map.get(batchKey)!.push(run)
  }

  const groups: BatchGroup[] = []
  for (const [batchKey, runs] of map) {
    runs.sort((a, b) => {
      if (a.runIndex != null && b.runIndex != null) return a.runIndex - b.runIndex
      return a.startTime - b.startTime
    })
    const dash = batchKey.indexOf('-')
    const prefix = dash > 0 ? batchKey.slice(0, dash) : batchKey
    const appName = dash > 0 ? batchKey.slice(dash + 1) : batchKey
    groups.push({
      batchKey,
      prefix: prefix || 'batch',
      appName: appName || batchKey,
      runs,
    })
  }

  groups.sort((a, b) => {
    const ta = b.runs[0]?.startTime ?? 0
    const tb = a.runs[0]?.startTime ?? 0
    return ta - tb
  })
  return groups
}
