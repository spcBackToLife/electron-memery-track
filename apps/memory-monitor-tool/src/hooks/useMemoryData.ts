/**
 * useMemoryData - 实时内存数据 Hook
 * 管理快照缓冲区、标记时间线、GC/标记操作
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import type { MemorySnapshot, EventMark, TestSession } from '../types'

export interface MemoryData {
  /** 当前会话 */
  currentSession: TestSession | null
  /** 快照缓冲区（当前会话的实时数据） */
  snapshots: MemorySnapshot[]
  /** 最新快照（用于指标卡片） */
  latestSnapshot: MemorySnapshot | null
  /** 标记时间线 */
  markTimeline: EventMark[]
  // 操作方法
  triggerGC: () => Promise<undefined>
  addMark: (label: string) => Promise<boolean>
  startSession: (label: string, description?: string) => Promise<unknown>
  stopSession: () => Promise<unknown>
}

// 缓冲区最大容量
const MAX_BUFFER_SIZE = 600

export function useMemoryData(): MemoryData {
  const [snapshots, setSnapshots] = useState<MemorySnapshot[]>([])
  const [currentSession, setCurrentSession] = useState<TestSession | null>(null)
  const snapshotsRef = useRef<MemorySnapshot[]>([])

  // 订阅实时快照
  useEffect(() => {
    const cleanup = window.monitorAPI.onSnapshotUpdate((data) => {
      const snapshot = data as MemorySnapshot

      setSnapshots((prev) => {
        const updated = [...prev, snapshot]
        if (updated.length > MAX_BUFFER_SIZE) {
          return updated.slice(-Math.floor(MAX_BUFFER_SIZE / 2))
        }
        return updated
      })
      snapshotsRef.current = [...snapshotsRef.current, snapshot].slice(-MAX_BUFFER_SIZE)
    })

    // 订阅会话状态变化
    const sessionStartCleanup = window.monitorAPI.onSessionStarted((data) => {
      setCurrentSession(data as TestSession)
      // 新会话开始时清空缓冲区
      setSnapshots([])
      snapshotsRef.current = []
    })

    const sessionEndCleanup = window.monitorAPI.onSessionEnded(() => {
      setCurrentSession(null)
      // 不清空 snapshots，便于查看刚结束会话的曲线
    })

    return () => {
      cleanup()
      sessionStartCleanup()
      sessionEndCleanup()
    }
  }, [])

  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

  // 收集所有快照中的标记
  const markTimeline: EventMark[] = (() => {
    const marks: EventMark[] = []
    for (const s of snapshots) {
      if (s.marks) marks.push(...s.marks)
    }
    return marks
  })()

  const addMark = useCallback(async (label: string): Promise<boolean> => {
    return window.monitorAPI.addMark(label)
  }, [])

  const triggerGC = useCallback(async (): Promise<undefined> => {
    // 本工具不提供 GC 功能（面向测试，不涉及 V8 调优）
    console.log('[MMT] GC not available in monitor tool mode')
    return undefined
  }, [])

  const startSession = useCallback(async (label: string, description?: string): Promise<unknown> => {
    return window.monitorAPI.startSession(label, description)
  }, [])

  const stopSession = useCallback(async (): Promise<unknown> => {
    return window.monitorAPI.stopSession()
  }, [])

  return {
    currentSession,
    snapshots,
    latestSnapshot,
    markTimeline,
    triggerGC,
    addMark,
    startSession,
    stopSession,
  }
}
