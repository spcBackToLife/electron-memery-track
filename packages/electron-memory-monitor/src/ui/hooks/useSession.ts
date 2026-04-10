import { useState, useCallback } from 'react'
import type { SessionsListPayload, TestSession } from '../../types/session'
import type { SessionReport } from '../../types/report'
import type { MemorySnapshot } from '../../types/snapshot'

export function useSession() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [sessions, setSessions] = useState<TestSession[]>([])

  const startSession = useCallback(async (label: string, description?: string) => {
    const api = window.monitorAPI
    if (!api?.startSession) {
      console.error('[@electron-memory/monitor] monitorAPI.startSession 不可用（请确认监控面板 preload 已注入）')
      return null
    }
    try {
      const sessionId = await api.startSession(label, description)
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
    const raw = await window.monitorAPI?.getSessions()
    if (raw == null) {
      return
    }

    let arr: TestSession[]
    let activeId: string | null = null

    if (Array.isArray(raw)) {
      arr = raw as TestSession[]
      activeId = arr.find((s) => s.status === 'running')?.id ?? null
    } else {
      const p = raw as SessionsListPayload
      arr = Array.isArray(p.sessions) ? p.sessions : []
      activeId = p.activeSessionId ?? null
    }

    setSessions(arr)
    setCurrentSessionId(activeId)
    setIsRunning(Boolean(activeId))
  }, [])

  const stopSession = useCallback(async () => {
    const api = window.monitorAPI
    if (!api?.stopSession) {
      console.error('[@electron-memory/monitor] monitorAPI.stopSession 不可用（请确认监控面板 preload 已注入）')
      await refreshSessions()
      return null
    }
    
    const STOP_IPC_MS = 120_000
    try {
      // 主进程只回传轻量字段；Race 防止主进程同步读盘过久导致 invoke 永不返回、按钮永久 disabled
      const result = (await Promise.race([
        api.stopSession(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `stopSession 超过 ${STOP_IPC_MS / 1000}s 未返回（主进程可能仍在读 snapshots / 写 report）`
                )
              ),
            STOP_IPC_MS
          )
        ),
      ])) as
        | { ok: true; sessionId: string; label: string; durationMs: number }
        | { ok: false; reason?: string; message?: string }
        | null
        | undefined

      await refreshSessions()

      /**
       * 主进程已无活动会话时的两种正常情况：
       * - ok: true：刚结束成功
       * - no_active_session：已结束过再点、或索引与内存曾短暂不一致
       * 二者都应把面板拉回「未开始会话」，不能依赖 refresh  alone（索引/竞态下仍可能读到旧的 running）
       */
      if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) {
          setCurrentSessionId(null)
          setIsRunning(false)
        } else if (result.reason === 'no_active_session') {
          setCurrentSessionId(null)
          setIsRunning(false)
        } else {
          console.error('[@electron-memory/monitor] stopSession failed:', result)
        }
      }

      return null
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
