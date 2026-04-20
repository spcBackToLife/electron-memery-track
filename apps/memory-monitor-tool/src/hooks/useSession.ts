/**
 * useSession - 会话管理 Hook
 * 提供开始/结束会话、刷新列表等功能
 */
import { useState, useCallback, useEffect } from 'react'
import type { TestSession } from '../types'

interface UseSessionReturn {
  isRunning: boolean
  currentSessionId: string | null
  sessions: TestSession[]
  startSession: (label: string, description?: string) => void
  stopSession: () => Promise<void>
  refreshSessions: () => Promise<void>
}

export function useSession(): UseSessionReturn {
  const [isRunning, setIsRunning] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<TestSession[]>([])

  const refreshSessions = useCallback(async () => {
    const list = await window.monitorAPI.listSessions() as TestSession[]
    setSessions(list)
    const running = list.find((s) => s.status === 'running')
    if (running) {
      setIsRunning(true)
      setCurrentSessionId(running.id)
    } else {
      setIsRunning(false)
      setCurrentSessionId(null)
    }
  }, [])

  const startSession = useCallback(async (label: string, description?: string) => {
    const session = await window.monitorAPI.startSession(label, description) as TestSession
    setIsRunning(true)
    setCurrentSessionId(session.id)
    await refreshSessions()
  }, [refreshSessions])

  const stopSession = useCallback(async () => {
    const pending = window.monitorAPI.stopSession()
    setIsRunning(false)
    setCurrentSessionId(null)
    try {
      await pending
    } catch {
      /* IPC 失败时仍以 refresh 对齐主进程状态 */
    }
    await refreshSessions()
  }, [refreshSessions])

  // 与主进程同步：自动开始/结束会话（如「启动并监控」在主进程里调用了 startSession）
  useEffect(() => {
    const offStart = window.monitorAPI.onSessionStarted(() => {
      void refreshSessions()
    })
    const offEnd = window.monitorAPI.onSessionEnded(() => {
      void refreshSessions()
    })
    return () => {
      offStart()
      offEnd()
    }
  }, [refreshSessions])

  return {
    isRunning,
    currentSessionId,
    sessions,
    startSession,
    stopSession,
    refreshSessions,
  }
}
