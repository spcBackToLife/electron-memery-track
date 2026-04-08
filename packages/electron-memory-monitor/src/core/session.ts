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

  /** 开始新会话 */
  startSession(label: string, description?: string): TestSession {
    // 如果有正在运行的会话，先结束它
    if (this.currentSession && this.currentSession.status === 'running') {
      this.endSession()
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

    return session
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
}
