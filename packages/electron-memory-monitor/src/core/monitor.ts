/**
 * ElectronMemoryMonitor - SDK 主入口
 * 
 * 门面类（Facade Pattern），提供简洁的 API
 * 一行代码即可接入：new ElectronMemoryMonitor()
 */

import { app } from 'electron'
import * as path from 'path'
import * as v8 from 'v8'
import { EventEmitter } from 'events'
import { MemoryCollector } from './collector'
import { DataPersister } from './persister'
import { SessionManager } from './session'
import { AnomalyDetector } from './anomaly'
import { Analyzer } from './analyzer'
import { DashboardManager } from './dashboard'
import { IPCMainHandler } from '../ipc/main-handler'
import { DEFAULT_CONFIG, type MonitorConfig } from '../types/config'
import type { MemorySnapshot, RendererV8Detail } from '../types/snapshot'
import type { TestSession } from '../types/session'
import type { AnomalyEvent } from '../types/anomaly'
import type { SessionReport, CompareReport, GCResult } from '../types/report'

export class ElectronMemoryMonitor extends EventEmitter {
  private config: MonitorConfig
  private collector: MemoryCollector
  private persister!: DataPersister
  private sessionManager!: SessionManager
  private anomalyDetector: AnomalyDetector
  private analyzer: Analyzer
  private dashboard: DashboardManager
  private ipcHandler!: IPCMainHandler
  private started = false
  private latestSnapshot: MemorySnapshot | null = null

  constructor(config?: Partial<MonitorConfig>) {
    super()

    // 合并配置
    this.config = this.mergeConfig(config)

    // 如果 disabled，则不做任何事
    if (!this.config.enabled) {
      this.collector = null as unknown as MemoryCollector
      this.anomalyDetector = null as unknown as AnomalyDetector
      this.analyzer = null as unknown as Analyzer
      this.dashboard = null as unknown as DashboardManager
      return
    }

    // 初始化各模块
    this.collector = new MemoryCollector(this.config)
    this.anomalyDetector = new AnomalyDetector(this.config)
    this.analyzer = new Analyzer()
    this.dashboard = new DashboardManager(this.config)

    // 如果 autoStart，则自动启动
    if (this.config.autoStart) {
      this.start()
    }
  }

  // ============ 生命周期 ============

  /** 启动监控 */
  async start(): Promise<void> {
    if (!this.config.enabled || this.started) return

    // 等待 app ready
    if (!app.isReady()) {
      await app.whenReady()
    }

    // 初始化存储目录
    const storageDir = this.config.storage.directory || path.join(app.getPath('userData'), 'memory-monitor')
    this.persister = new DataPersister(this.config, storageDir)
    this.sessionManager = new SessionManager(this.persister)

    // 注册 IPC
    this.ipcHandler = new IPCMainHandler(this)
    this.ipcHandler.register()

    // 连接采集器事件
    this.collector.on('snapshot', (snapshot: MemorySnapshot) => {
      this.onSnapshot(snapshot)
    })

    // 连接异常检测事件
    this.anomalyDetector.on('anomaly', (anomaly: AnomalyEvent) => {
      this.emit('anomaly', anomaly)
      this.ipcHandler.pushAnomaly(this.dashboard.getWindow(), anomaly)
    })

    // 启动采集
    this.collector.start()

    // 启动异常检测
    this.anomalyDetector.start()

    // 打开监控面板
    if (this.config.openDashboardOnStart) {
      this.openDashboard()
    }

    // 清理过期会话
    this.persister.cleanOldSessions()

    this.started = true
  }

  /** 停止监控 */
  async stop(): Promise<void> {
    if (!this.started) return

    this.collector.stop()
    this.anomalyDetector.stop()

    // 如果有正在运行的会话，结束它
    const currentSession = this.sessionManager.getCurrentSession()
    if (currentSession) {
      await this.stopSession()
    }

    this.persister.close()
    this.started = false
  }

  /** 销毁实例 */
  async destroy(): Promise<void> {
    await this.stop()
    this.dashboard.destroy()
    if (this.ipcHandler) {
      this.ipcHandler.unregister()
    }
    this.removeAllListeners()
  }

  // ============ 会话控制 ============

  /** 开始新会话 */
  startSession(label: string, description?: string): string {
    if (!this.started) {
      throw new Error('Monitor is not started')
    }

    const session = this.sessionManager.startSession(label, description)
    this.collector.setSessionId(session.id)
    this.anomalyDetector.clearAnomalies()

    return session.id
  }

  /** 结束当前会话 */
  async stopSession(): Promise<SessionReport | null> {
    if (!this.started) return null

    const session = this.sessionManager.getCurrentSession()
    if (!session) return null

    // 结束会话
    const completedSession = this.sessionManager.endSession()
    if (!completedSession) return null

    this.collector.setSessionId(null)

    // 生成报告
    const snapshots = this.persister.readSessionSnapshots(completedSession.id)
    const anomalies = this.anomalyDetector.getAnomalies()

    const report = this.analyzer.generateReport(
      completedSession.id,
      completedSession.label,
      completedSession.description,
      completedSession.startTime,
      completedSession.endTime!,
      snapshots,
      anomalies,
      completedSession.dataFile
    )

    // 保存报告
    const reportPath = path.join(this.persister.getStorageDir(), completedSession.id, 'report.json')
    const fs = await import('fs')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8')

    this.emit('session-end', report)
    return report
  }

  // ============ 监控面板 ============

  /** 打开监控面板 */
  openDashboard(): void {
    this.dashboard.open()

    // 设置监控窗口 ID，用于在进程列表中标记
    const wcId = this.dashboard.getWebContentsId()
    this.collector.setMonitorWindowId(wcId)
  }

  /** 关闭监控面板 */
  closeDashboard(): void {
    this.dashboard.close()
    this.collector.setMonitorWindowId(null)
  }

  // ============ 数据访问 ============

  /** 获取当前最新快照 */
  getCurrentSnapshot(): MemorySnapshot | null {
    return this.latestSnapshot
  }

  /** 获取历史会话列表 */
  async getSessions(): Promise<TestSession[]> {
    return this.sessionManager.getSessions()
  }

  /** 获取指定会话报告 */
  async getSessionReport(sessionId: string): Promise<SessionReport | null> {
    const fs = await import('fs')
    const reportPath = path.join(this.persister.getStorageDir(), sessionId, 'report.json')

    try {
      const content = fs.readFileSync(reportPath, 'utf-8')
      return JSON.parse(content) as SessionReport
    } catch {
      // 报告不存在，尝试从原始数据重新生成
      const session = this.sessionManager.getSession(sessionId)
      if (!session || !session.endTime) return null

      const snapshots = this.persister.readSessionSnapshots(sessionId)
      if (snapshots.length === 0) return null

      return this.analyzer.generateReport(
        session.id,
        session.label,
        session.description,
        session.startTime,
        session.endTime,
        snapshots,
        [],
        session.dataFile
      )
    }
  }

  /** 获取指定会话的快照数据（支持时间过滤和降采样） */
  async getSessionSnapshots(
    sessionId: string,
    startTime?: number,
    endTime?: number,
    maxPoints?: number
  ): Promise<MemorySnapshot[]> {
    let snapshots = this.persister.readSessionSnapshots(sessionId)

    // 时间范围过滤
    if (startTime != null) {
      snapshots = snapshots.filter((s) => s.timestamp >= startTime)
    }
    if (endTime != null) {
      snapshots = snapshots.filter((s) => s.timestamp <= endTime)
    }

    // 降采样：如果数据点超过 maxPoints，均匀采样
    const limit = maxPoints ?? 600
    if (snapshots.length > limit) {
      const step = snapshots.length / limit
      const sampled: MemorySnapshot[] = []
      for (let i = 0; i < limit; i++) {
        sampled.push(snapshots[Math.round(i * step)])
      }
      // 确保包含最后一个点
      if (sampled[sampled.length - 1] !== snapshots[snapshots.length - 1]) {
        sampled[sampled.length - 1] = snapshots[snapshots.length - 1]
      }
      snapshots = sampled
    }

    return snapshots
  }

  /** 对比两个会话 */
  async compareSessions(baseId: string, targetId: string): Promise<CompareReport | null> {
    const baseReport = await this.getSessionReport(baseId)
    const targetReport = await this.getSessionReport(targetId)

    if (!baseReport || !targetReport) return null

    return this.analyzer.compareReports(baseReport, targetReport)
  }

  /** 导出会话数据（供 IPC 调用，弹出保存对话框） */
  async exportSession(sessionId: string): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
      const { dialog } = await import('electron')
      const session = this.sessionManager.getSession(sessionId)
      if (!session) return { success: false, error: '会话不存在' }

      const defaultName = `emm-${session.label.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')}-${new Date(session.startTime).toISOString().slice(0, 10)}.emmsession`

      const result = await dialog.showSaveDialog({
        title: '导出会话数据',
        defaultPath: defaultName,
        filters: [
          { name: 'EMM Session', extensions: ['emmsession'] },
          { name: 'JSON 文件', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })

      if (result.canceled || !result.filePath) {
        return { success: false, error: '用户取消' }
      }

      const exportData = this.persister.exportSession(sessionId)
      const fs = await import('fs')
      const fileContent = JSON.stringify({
        version: 1,
        exportTime: Date.now(),
        ...exportData,
      }, null, 2)
      fs.writeFileSync(result.filePath, fileContent, 'utf-8')

      return { success: true, filePath: result.filePath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /** 导入会话数据（供 IPC 调用，弹出打开对话框） */
  async importSession(): Promise<{ success: boolean; session?: TestSession; error?: string }> {
    try {
      const { dialog } = await import('electron')

      const result = await dialog.showOpenDialog({
        title: '导入会话数据',
        filters: [
          { name: 'EMM Session', extensions: ['emmsession'] },
          { name: 'JSON 文件', extensions: ['json'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '用户取消' }
      }

      const fs = await import('fs')
      const content = fs.readFileSync(result.filePaths[0], 'utf-8')
      const parsed = JSON.parse(content)

      if (!parsed.meta || !parsed.snapshots) {
        return { success: false, error: '文件格式不正确，缺少 meta 或 snapshots 数据' }
      }

      const session = this.persister.importSession({
        meta: parsed.meta,
        snapshots: parsed.snapshots,
        report: parsed.report || null,
      })

      return { success: true, session }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  /** 删除指定会话 */
  async deleteSession(sessionId: string): Promise<boolean> {
    return this.persister.deleteSession(sessionId)
  }

  // ============ 工具方法 ============

  /** 手动触发 GC */
  async triggerGC(): Promise<GCResult> {
    const beforeMem = process.memoryUsage()

    if (global.gc) {
      global.gc()
    } else {
      // 尝试通过 v8 flag 触发
      try {
        v8.writeHeapSnapshot // 触发 GC 的 workaround
      } catch {
        // 忽略
      }
    }

    // 等待一小段时间让 GC 完成
    await new Promise((resolve) => setTimeout(resolve, 100))

    const afterMem = process.memoryUsage()
    const freed = beforeMem.heapUsed - afterMem.heapUsed

    return {
      beforeHeapUsed: beforeMem.heapUsed,
      afterHeapUsed: afterMem.heapUsed,
      freed,
      freedPercent: beforeMem.heapUsed > 0 ? (freed / beforeMem.heapUsed) * 100 : 0,
      timestamp: Date.now(),
    }
  }

  /** 导出堆快照 */
  async takeHeapSnapshot(filePath?: string): Promise<string> {
    const snapshotPath = filePath || path.join(
      this.persister.getStorageDir(),
      `heap-${Date.now()}.heapsnapshot`
    )
    v8.writeHeapSnapshot(snapshotPath)
    return snapshotPath
  }

  /** 添加事件标记 */
  mark(label: string, metadata?: Record<string, unknown>): void {
    this.collector.addMark(label, metadata)
  }

  /** 更新渲染进程 V8 详情 */
  updateRendererDetail(detail: RendererV8Detail): void {
    this.collector.updateRendererDetail(detail)
  }

  /** 获取当前配置 */
  getConfig(): MonitorConfig {
    return { ...this.config }
  }

  // ============ 事件类型重载 ============

  on(event: 'snapshot', handler: (data: MemorySnapshot) => void): this
  on(event: 'anomaly', handler: (event: AnomalyEvent) => void): this
  on(event: 'session-end', handler: (report: SessionReport) => void): this
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, handler: (...args: any[]) => void): this {
    return super.on(event, handler)
  }

  // ============ 私有方法 ============

  private onSnapshot(snapshot: MemorySnapshot): void {
    this.latestSnapshot = snapshot

    // 写入持久化
    if (this.sessionManager.getCurrentSession()) {
      this.persister.writeSnapshot(snapshot)
      this.sessionManager.incrementSnapshotCount()
    }

    // 喂给异常检测
    this.anomalyDetector.addSnapshot(snapshot)

    // 推送给面板
    this.ipcHandler?.pushSnapshot(this.dashboard.getWindow(), snapshot)

    // 触发事件
    this.emit('snapshot', snapshot)
  }

  private mergeConfig(userConfig?: Partial<MonitorConfig>): MonitorConfig {
    if (!userConfig) return { ...DEFAULT_CONFIG }

    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      anomaly: {
        ...DEFAULT_CONFIG.anomaly,
        ...(userConfig.anomaly || {}),
      },
      storage: {
        ...DEFAULT_CONFIG.storage,
        ...(userConfig.storage || {}),
      },
      dashboard: {
        ...DEFAULT_CONFIG.dashboard,
        ...(userConfig.dashboard || {}),
      },
      processLabels: {
        ...DEFAULT_CONFIG.processLabels,
        ...(userConfig.processLabels || {}),
      },
    }
  }
}
