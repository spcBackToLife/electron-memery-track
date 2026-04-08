/**
 * DataPersister - 数据持久化模块
 * 
 * 使用 JSONL (JSON Lines) 格式流式存储快照数据
 * 追加写入，不阻塞采集
 */

import * as fs from 'fs'
import * as path from 'path'
import type { MemorySnapshot } from '../types/snapshot'
import type { TestSession, SessionIndex } from '../types/session'
import type { MonitorConfig } from '../types/config'

export class DataPersister {
  private config: MonitorConfig
  private storageDir: string
  private buffer: MemorySnapshot[] = []
  private currentStream: fs.WriteStream | null = null
  private currentDataFile: string | null = null

  constructor(config: MonitorConfig, storageDir: string) {
    this.config = config
    this.storageDir = storageDir
    this.ensureDirectory(this.storageDir)
  }

  /** 获取存储目录 */
  getStorageDir(): string {
    return this.storageDir
  }

  /** 创建新的会话数据文件 */
  createSessionFiles(sessionId: string): { dataFile: string; metaFile: string } {
    const sessionDir = path.join(this.storageDir, sessionId)
    this.ensureDirectory(sessionDir)

    const dataFile = path.join(sessionDir, 'snapshots.jsonl')
    const metaFile = path.join(sessionDir, 'meta.json')

    // 关闭之前的流
    this.closeStream()

    // 打开新的写入流
    this.currentDataFile = dataFile
    this.currentStream = fs.createWriteStream(dataFile, { flags: 'a' })

    return { dataFile, metaFile }
  }

  /** 写入快照数据 */
  writeSnapshot(snapshot: MemorySnapshot): void {
    this.buffer.push(snapshot)

    // 达到批量写入阈值
    if (this.buffer.length >= this.config.persistInterval) {
      this.flush()
    }
  }

  /** 刷新缓冲区到磁盘 */
  flush(): void {
    if (this.buffer.length === 0 || !this.currentStream) return

    const lines = this.buffer.map((s) => JSON.stringify(s)).join('\n') + '\n'
    this.currentStream.write(lines)
    this.buffer = []
  }

  /** 保存会话元信息 */
  saveSessionMeta(session: TestSession): void {
    const metaFile = path.join(this.storageDir, session.id, 'meta.json')
    fs.writeFileSync(metaFile, JSON.stringify(session, null, 2), 'utf-8')

    // 更新索引
    this.updateSessionIndex(session)
  }

  /** 读取会话元信息 */
  readSessionMeta(sessionId: string): TestSession | null {
    const metaFile = path.join(this.storageDir, sessionId, 'meta.json')
    try {
      const content = fs.readFileSync(metaFile, 'utf-8')
      return JSON.parse(content) as TestSession
    } catch {
      return null
    }
  }

  /** 获取所有会话列表 */
  getSessions(): TestSession[] {
    const indexFile = path.join(this.storageDir, 'sessions.json')
    try {
      const content = fs.readFileSync(indexFile, 'utf-8')
      const index = JSON.parse(content) as SessionIndex
      return index.sessions
    } catch {
      return []
    }
  }

  /** 读取会话的所有快照数据 */
  readSessionSnapshots(sessionId: string): MemorySnapshot[] {
    const dataFile = path.join(this.storageDir, sessionId, 'snapshots.jsonl')
    try {
      const content = fs.readFileSync(dataFile, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      return lines.map((line) => JSON.parse(line) as MemorySnapshot)
    } catch {
      return []
    }
  }

  /** 关闭流并刷新缓冲区 */
  close(): void {
    this.flush()
    this.closeStream()
  }

  /** 清理过期会话 */
  cleanOldSessions(): void {
    const sessions = this.getSessions()
    if (sessions.length <= this.config.storage.maxSessions) return

    // 删除最旧的会话
    const toRemove = sessions
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, sessions.length - this.config.storage.maxSessions)

    for (const session of toRemove) {
      const sessionDir = path.join(this.storageDir, session.id)
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      } catch {
        // 忽略删除失败
      }
    }

    // 更新索引
    const remaining = sessions.filter((s) => !toRemove.includes(s))
    this.saveSessionIndex(remaining)
  }

  /** 导出会话数据为单个 JSON 包 */
  exportSession(sessionId: string): {
    meta: TestSession | null
    snapshots: string
    report: string | null
  } {
    const meta = this.readSessionMeta(sessionId)
    const snapshotsFile = path.join(this.storageDir, sessionId, 'snapshots.jsonl')
    const reportFile = path.join(this.storageDir, sessionId, 'report.json')

    let snapshots = ''
    try { snapshots = fs.readFileSync(snapshotsFile, 'utf-8') } catch { /* empty */ }

    let report: string | null = null
    try { report = fs.readFileSync(reportFile, 'utf-8') } catch { /* empty */ }

    return { meta, snapshots, report }
  }

  /** 导入会话数据 */
  importSession(data: {
    meta: TestSession
    snapshots: string
    report: string | null
  }): TestSession {
    const { meta, snapshots, report } = data
    const sessionDir = path.join(this.storageDir, meta.id)
    this.ensureDirectory(sessionDir)

    // 写入快照文件
    const snapshotsFile = path.join(sessionDir, 'snapshots.jsonl')
    fs.writeFileSync(snapshotsFile, snapshots, 'utf-8')

    // 更新路径为本地路径
    meta.dataFile = snapshotsFile
    meta.metaFile = path.join(sessionDir, 'meta.json')

    // 写入元信息
    fs.writeFileSync(meta.metaFile, JSON.stringify(meta, null, 2), 'utf-8')

    // 写入报告
    if (report) {
      const reportFile = path.join(sessionDir, 'report.json')
      fs.writeFileSync(reportFile, report, 'utf-8')
    }

    // 更新索引
    this.updateSessionIndex(meta)

    return meta
  }

  /** 删除指定会话 */
  deleteSession(sessionId: string): boolean {
    const sessionDir = path.join(this.storageDir, sessionId)
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    } catch {
      return false
    }

    // 更新索引
    const sessions = this.getSessions().filter((s) => s.id !== sessionId)
    this.saveSessionIndex(sessions)
    return true
  }

  // ===== 私有方法 =====

  private closeStream(): void {
    if (this.currentStream) {
      this.currentStream.end()
      this.currentStream = null
      this.currentDataFile = null
    }
  }

  private updateSessionIndex(session: TestSession): void {
    const sessions = this.getSessions()
    const existingIdx = sessions.findIndex((s) => s.id === session.id)
    if (existingIdx >= 0) {
      sessions[existingIdx] = session
    } else {
      sessions.push(session)
    }
    this.saveSessionIndex(sessions)
  }

  private saveSessionIndex(sessions: TestSession[]): void {
    const indexFile = path.join(this.storageDir, 'sessions.json')
    const index: SessionIndex = {
      sessions,
      lastUpdated: Date.now(),
    }
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), 'utf-8')
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}
