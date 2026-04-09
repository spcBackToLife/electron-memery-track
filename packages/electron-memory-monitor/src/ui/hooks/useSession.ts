import { useState, useCallback } from 'react'
import type { TestSession } from '../../types/session'
import type { SessionReport } from '../../types/report'
import type { MemorySnapshot } from '../../types/snapshot'

export function useSession() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [sessions, setSessions] = useState<TestSession[]>([])

  const startSession = useCallback(async (label: string, description?: string) => {
    try {
      const sessionId = await window.monitorAPI?.startSession(label, description)
      if (sessionId) {
        setCurrentSessionId(sessionId as string)
        setIsRunning(true)
      }
      return sessionId
    } catch (err) {
      console.error('[@electron-memory/monitor] startSession failed:', err)
      return null
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    const list = await window.monitorAPI?.getSessions()
    if (!list) {
      return
    }
    const arr = list as TestSession[]
    setSessions(arr)
    const running = arr.find(s => s.status === 'running')
    setCurrentSessionId(running?.id ?? null)
    setIsRunning(Boolean(running))
  }, [])

  const stopSession = useCallback(async () => {
    try {
      const report = await window.monitorAPI?.stopSession()
      setCurrentSessionId(null)
      setIsRunning(false)
      await refreshSessions()
      return report as SessionReport | null
    } catch (err) {
      console.error('[@electron-memory/monitor] stopSession failed:', err)
      await refreshSessions()
      return null
    }
  }, [refreshSessions])

  const getSessionReport = useCallback(async (sessionId: string) => {
    return (await window.monitorAPI?.getSessionReport(sessionId)) as SessionReport | null
  }, [])

  const getSessionSnapshots = useCallback(async (
    sessionId: string,
    startTime?: number,
    endTime?: number,
    maxPoints?: number
  ) => {
    const data = await window.monitorAPI?.getSessionSnapshots(sessionId, startTime, endTime, maxPoints)
    return (data || []) as MemorySnapshot[]
  }, [])

  const compareSessions = useCallback(async (baseId: string, targetId: string) => {
    return window.monitorAPI?.compareSessions(baseId, targetId)
  }, [])

  const exportSession = useCallback(async (sessionId: string) => {
    const result = await window.monitorAPI?.exportSession(sessionId)
    return result
  }, [])

  const importSession = useCallback(async () => {
    const result = await window.monitorAPI?.importSession()
    if (result?.success) {
      await refreshSessions()
    }
    return result
  }, [refreshSessions])

  const deleteSession = useCallback(async (sessionId: string) => {
    const ok = await window.monitorAPI?.deleteSession(sessionId)
    if (ok) {
      await refreshSessions()
    }
    return ok
  }, [refreshSessions])

  return {
    currentSessionId,
    isRunning,
    sessions,
    startSession,
    stopSession,
    refreshSessions,
    getSessionReport,
    getSessionSnapshots,
    compareSessions,
    exportSession,
    importSession,
    deleteSession,
  }
}
