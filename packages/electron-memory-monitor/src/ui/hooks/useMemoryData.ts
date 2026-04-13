import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { MemorySnapshot } from '../../types/snapshot'
import { eventMarksFromSnapshots } from '../utils/eventMarksFromSnapshots'
import type { AnomalyEvent } from '../../types/anomaly'
import type { GCResult, SessionEventMark } from '../../types/report'

declare global {
  interface Window {
    monitorAPI: {
      onSnapshot: (callback: (data: MemorySnapshot) => void) => void
      onAnomaly: (callback: (data: AnomalyEvent) => void) => void
      removeSnapshotListener: () => void
      removeAnomalyListener: () => void
      triggerGC: () => Promise<GCResult>
      addMark: (label: string, metadata?: Record<string, unknown>) => Promise<void>
      startSession: (label: string, description?: string) => Promise<string>
      stopSession: () => Promise<unknown>
      getSessions: () => Promise<unknown[]>
      getSessionReport: (sessionId: string) => Promise<unknown>
      compareSessions: (baseId: string, targetId: string) => Promise<unknown>
      getSessionSnapshots: (sessionId: string, startTime?: number, endTime?: number, maxPoints?: number) => Promise<unknown[]>
      exportSession: (sessionId: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
      importSession: () => Promise<{ success: boolean; session?: unknown; error?: string }>
      deleteSession: (sessionId: string) => Promise<boolean>
      takeHeapSnapshot: (filePath?: string) => Promise<string>
      getConfig: () => Promise<unknown>
    }
  }
}

const MAX_SNAPSHOTS = 300 // 保留最近 5 分钟数据（@1s间隔）

/** useMemoryData 返回值的类型定义，供外部组件（如 Dashboard props）引用 */
export interface MemoryData {
  snapshots: MemorySnapshot[]
  latestSnapshot: MemorySnapshot | null
  anomalies: AnomalyEvent[]
  isCollecting: boolean
  triggerGC: () => Promise<GCResult | undefined>
  addMark: (label: string) => Promise<void | undefined>
  clearAnomalies: () => void
  markTimeline: SessionEventMark[]
  takeHeapSnapshot: (filePath?: string) => Promise<string | undefined>
}

export function useMemoryData(): MemoryData {
  const [snapshots, setSnapshots] = useState<MemorySnapshot[]>([])
  const [latestSnapshot, setLatestSnapshot] = useState<MemorySnapshot | null>(null)
  const [anomalies, setAnomalies] = useState<AnomalyEvent[]>([])
  const [isCollecting, setIsCollecting] = useState(false)
  const snapshotsRef = useRef<MemorySnapshot[]>([])

  useEffect(() => {
    const handleSnapshot = (data: MemorySnapshot) => {
      setLatestSnapshot(data)
      setIsCollecting(true)

      snapshotsRef.current = [...snapshotsRef.current, data].slice(-MAX_SNAPSHOTS)
      setSnapshots(snapshotsRef.current)
    }

    const handleAnomaly = (event: AnomalyEvent) => {
      setAnomalies((prev) => [...prev, event])
    }

    window.monitorAPI?.onSnapshot(handleSnapshot)
    window.monitorAPI?.onAnomaly(handleAnomaly)

    return () => {
      window.monitorAPI?.removeSnapshotListener()
      window.monitorAPI?.removeAnomalyListener()
    }
  }, [])

  const triggerGC = useCallback(async () => {
    return window.monitorAPI?.triggerGC()
  }, [])

  const addMark = useCallback(async (label: string) => {
    return window.monitorAPI?.addMark(label)
  }, [])

  const clearAnomalies = useCallback(() => {
    setAnomalies([])
  }, [])

  const takeHeapSnapshot = useCallback(async (filePath?: string) => {
    return window.monitorAPI?.takeHeapSnapshot(filePath)
  }, [])

  const markTimeline = useMemo(() => eventMarksFromSnapshots(snapshots), [snapshots])

  return {
    snapshots,
    latestSnapshot,
    anomalies,
    isCollecting,
    triggerGC,
    addMark,
    clearAnomalies,
    markTimeline,
    takeHeapSnapshot,
  }
}
