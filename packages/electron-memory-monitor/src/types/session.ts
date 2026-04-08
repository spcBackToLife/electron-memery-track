/**
 * 测试会话相关类型
 */

export interface TestSession {
  /** 会话唯一 ID */
  id: string
  /** 用户标签，如 "v1.2.0-空载基准" */
  label: string
  /** 描述 */
  description?: string
  /** 开始时间 (ms) */
  startTime: number
  /** 结束时间 (ms) */
  endTime?: number
  /** 持续时长 (ms) */
  duration?: number
  /** 状态 */
  status: 'running' | 'completed' | 'aborted'
  /** 快照数量 */
  snapshotCount: number
  /** 数据文件路径 */
  dataFile: string
  /** 元数据文件路径 */
  metaFile: string
}

/** 会话索引（存在 sessions.json 中） */
export interface SessionIndex {
  sessions: TestSession[]
  lastUpdated: number
}
