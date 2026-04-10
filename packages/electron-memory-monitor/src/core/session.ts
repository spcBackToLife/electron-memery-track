/**
 * SessionManager - 会话管理
 * 
 * 管理测试会话的生命周期：创建、结束、查询
 */

import { v4 as generateId } from './utils'
import type { TestSession } from '../types/session'
import type { DataPersister } from './persister'

export class SessionManager {
  private persister: DataPersister
  private currentSession: TestSession | null = null

  constructor(persister: DataPersister) {
    this.persister = persister
  }

  /** 获取当前正在运行的会话 */
  getCurrentSession(): TestSession | null {
    return this.currentSession
  }

  /** 开始新会话；若顶替了上一条进行中的会话，通过 `replaced` 返回以便主进程补写 report.json */
  startSession(label: string, description?: string): { session: TestSession; replaced: TestSession | null } {
    // 冷启动或当前无内存会话时，索引里若仍有 running，多为崩溃残留，与内存不一致
    if (!this.currentSession) {
      this.reconcileStaleRunningInIndex()
    }

    let replaced: TestSession | null = null
    if (this.currentSession && this.currentSession.status === 'running') {
      replaced = this.endSession()
    }

    const sessionId = generateId()
    const { dataFile, metaFile } = this.persister.createSessionFiles(sessionId)

    const session: TestSession = {
      id: sessionId,
      label,
      description,
      startTime: Date.now(),
      status: 'running',
      snapshotCount: 0,
      dataFile,
      metaFile,
    }

    this.currentSession = session
    this.persister.saveSessionMeta(session)

    return { session, replaced }
  }

  /** 结束当前会话 */
  endSession(): TestSession | null {
    if (!this.currentSession) return null

    this.currentSession.endTime = Date.now()
    this.currentSession.duration = this.currentSession.endTime - this.currentSession.startTime
    this.currentSession.status = 'completed'

    this.persister.flush()
    this.persister.saveSessionMeta(this.currentSession)

    const session = { ...this.currentSession }
    this.currentSession = null

    return session
  }

  /** 增加当前会话的快照计数 */
  incrementSnapshotCount(): void {
    if (this.currentSession) {
      this.currentSession.snapshotCount++
    }
  }

  /** 获取所有会话 */
  getSessions(): TestSession[] {
    return this.persister.getSessions()
  }

  /** 获取指定会话 */
  getSession(sessionId: string): TestSession | null {
    return this.persister.readSessionMeta(sessionId)
  }

  /**
   * 当前内存无活动会话时，将索引中仍为 running 的条目标为 aborted（进程异常退出后残留）
   */
  reconcileStaleRunningInIndex(): void {
    if (this.currentSession) return

    const sessions = this.persister.getSessions()
    const now = Date.now()
    for (const s of sessions) {
      if (s.status !== 'running') continue
      const fixed: TestSession = {
        ...s,
        status: 'aborted',
        endTime: now,
        duration: now - s.startTime,
      }
      this.persister.saveSessionMeta(fixed)
    }
  }
}
