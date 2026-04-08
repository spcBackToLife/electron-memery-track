/**
 * AnomalyDetector - 异常检测引擎
 * 
 * 基于滑动窗口的内存异常检测
 * 内置 4 种检测策略：持续增长、突增、阈值、分离上下文
 */

import { EventEmitter } from 'events'
import { v4 as generateId, linearRegression, average } from './utils'
import type { MemorySnapshot } from '../types/snapshot'
import type { AnomalyEvent, AnomalyRule } from '../types/anomaly'
import type { MonitorConfig } from '../types/config'

export class AnomalyDetector extends EventEmitter {
  private config: MonitorConfig
  private snapshots: MemorySnapshot[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private maxWindowSize = 300 // 保留最近 300 条（5 分钟 @1s间隔）
  private detectedAnomalies: AnomalyEvent[] = []
  private builtinRules: AnomalyRule[]

  constructor(config: MonitorConfig) {
    super()
    this.config = config
    this.builtinRules = this.createBuiltinRules()
  }

  /** 添加快照到检测窗口 */
  addSnapshot(snapshot: MemorySnapshot): void {
    this.snapshots.push(snapshot)
    if (this.snapshots.length > this.maxWindowSize) {
      this.snapshots.shift()
    }
  }

  /** 获取所有检测到的异常 */
  getAnomalies(): AnomalyEvent[] {
    return [...this.detectedAnomalies]
  }

  /** 清空异常记录 */
  clearAnomalies(): void {
    this.detectedAnomalies = []
  }

  /** 开始定时检测 */
  start(): void {
    if (!this.config.anomaly.enabled || this.timer) return

    this.timer = setInterval(() => {
      this.runDetection()
    }, this.config.anomaly.checkInterval)
  }

  /** 停止检测 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 执行一次检测 */
  private runDetection(): void {
    if (this.snapshots.length < 10) return // 数据不足

    const latest = this.snapshots[this.snapshots.length - 1]
    const allRules = [...this.builtinRules, ...this.config.anomaly.rules]

    for (const rule of allRules) {
      if (!rule.enabled) continue
      try {
        const anomaly = rule.detect(this.snapshots, latest)
        if (anomaly) {
          this.detectedAnomalies.push(anomaly)
          this.emit('anomaly', anomaly)
        }
      } catch {
        // 忽略规则执行错误
      }
    }
  }

  /** 创建内置检测规则 */
  private createBuiltinRules(): AnomalyRule[] {
    return [
      // 规则1：总内存持续增长
      {
        id: 'continuous-growth',
        name: '总内存持续增长',
        enabled: true,
        detect: (snapshots: MemorySnapshot[]) => {
          if (snapshots.length < 60) return null // 至少 1 分钟数据

          const values = snapshots.map((s) => s.totalWorkingSetSize)
          const timestamps = snapshots.map((s) => s.timestamp)
          const { slope, r2 } = linearRegression(values, timestamps)

          // 斜率 > 10 KB/s 且 R² > 0.7
          if (slope > 10 && r2 > 0.7) {
            return {
              id: generateId(),
              timestamp: Date.now(),
              severity: r2 > 0.9 ? 'critical' : 'warning',
              category: 'memory-leak',
              title: '总内存持续增长',
              description: `内存以 ${slope.toFixed(2)} KB/s 的速率持续增长 (R²=${r2.toFixed(3)})`,
              value: slope,
              threshold: 10,
            }
          }
          return null
        },
      },

      // 规则2：内存突增（spike）
      {
        id: 'memory-spike',
        name: '内存突增',
        enabled: true,
        detect: (snapshots: MemorySnapshot[], latest: MemorySnapshot) => {
          if (snapshots.length < 10) return null

          const recentValues = snapshots.slice(-30).map((s) => s.totalWorkingSetSize)
          const avg = average(recentValues)
          const current = latest.totalWorkingSetSize

          // 当前值超过近期平均值的 50%
          if (avg > 0 && (current - avg) / avg > 0.5) {
            return {
              id: generateId(),
              timestamp: Date.now(),
              severity: 'warning',
              category: 'spike',
              title: '内存突增',
              description: `总内存从 ${Math.round(avg)} KB 突增到 ${current} KB (+${(((current - avg) / avg) * 100).toFixed(1)}%)`,
              value: current,
              threshold: avg * 1.5,
            }
          }
          return null
        },
      },

      // 规则3：分离上下文检测
      {
        id: 'detached-contexts',
        name: '分离上下文',
        enabled: true,
        detect: (_snapshots: MemorySnapshot[], latest: MemorySnapshot) => {
          const detached = latest.mainProcessV8Detail?.numberOfDetachedContexts
          if (detached && detached > 0) {
            return {
              id: generateId(),
              timestamp: Date.now(),
              severity: 'critical',
              category: 'detached-context',
              title: `检测到 ${detached} 个分离的 V8 上下文`,
              description: '存在未正确销毁的 BrowserWindow 或 WebContents，可能导致内存泄漏',
              value: detached,
              threshold: 0,
            }
          }
          return null
        },
      },

      // 规则4：V8 堆使用率过高
      {
        id: 'heap-usage-high',
        name: 'V8 堆使用率过高',
        enabled: true,
        detect: (_snapshots: MemorySnapshot[], latest: MemorySnapshot) => {
          const { heapUsed, heapTotal } = latest.mainProcessMemory
          if (heapTotal > 0) {
            const usagePercent = heapUsed / heapTotal
            if (usagePercent > 0.85) {
              return {
                id: generateId(),
                timestamp: Date.now(),
                severity: usagePercent > 0.95 ? 'critical' : 'warning',
                category: 'threshold',
                title: `V8 堆使用率 ${(usagePercent * 100).toFixed(1)}%`,
                description: `主进程 V8 堆使用 ${Math.round(heapUsed / 1024 / 1024)} MB / ${Math.round(heapTotal / 1024 / 1024)} MB`,
                value: usagePercent * 100,
                threshold: 85,
              }
            }
          }
          return null
        },
      },
    ]
  }
}
