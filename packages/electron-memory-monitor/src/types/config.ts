/**
 * SDK 配置类型
 */

import type { AnomalyRule } from './anomaly'

export interface MonitorConfig {
  // ===== 开关控制 =====
  /** 总开关，默认 true */
  enabled: boolean
  /** 实例化后是否自动开始采集，默认 true */
  autoStart: boolean
  /** 启动后是否自动打开监控面板，默认 true */
  openDashboardOnStart: boolean

  // ===== 采集配置 =====
  /** 采集间隔 (ms)，默认 2000 */
  collectInterval: number
  /** 落盘间隔 (条数)，默认 60 */
  persistInterval: number
  /** 是否采集渲染进程 V8 详情（需要 preload 配合），默认 false */
  enableRendererDetail: boolean
  /** 是否采集 V8 堆空间详情，默认 true */
  enableV8HeapSpaces: boolean

  // ===== 异常检测 =====
  anomaly: {
    /** 是否启用异常检测，默认 true */
    enabled: boolean
    /** 检测间隔 (ms)，默认 30000 */
    checkInterval: number
    /** 自定义检测规则（追加到内置规则） */
    rules: AnomalyRule[]
  }

  // ===== 存储配置 =====
  storage: {
    /** 数据存储目录，默认 app.getPath('userData') + '/memory-monitor' */
    directory: string
    /** 最大保留会话数，默认 50 */
    maxSessions: number
    /** 单次会话最大时长 (ms)，默认 24h */
    maxSessionDuration: number
  }

  // ===== 监控面板配置 =====
  dashboard: {
    /** 窗口宽度，默认 1400 */
    width: number
    /** 窗口高度，默认 900 */
    height: number
    /** 是否置顶，默认 false */
    alwaysOnTop: boolean
  }

  // ===== 进程标注 =====
  /** 给窗口进程打标签，方便识别 */
  processLabels: Record<string, string>
}

/** 默认配置 */
export const DEFAULT_CONFIG: MonitorConfig = {
  enabled: true,
  autoStart: true,
  openDashboardOnStart: true,

  collectInterval: 2000,
  persistInterval: 60,
  enableRendererDetail: false,
  enableV8HeapSpaces: true,

  anomaly: {
    enabled: true,
    checkInterval: 30000,
    rules: [],
  },

  storage: {
    directory: '', // 运行时由 app.getPath('userData') 填充
    maxSessions: 50,
    maxSessionDuration: 24 * 60 * 60 * 1000,
  },

  dashboard: {
    width: 1400,
    height: 900,
    alwaysOnTop: false,
  },

  processLabels: {},
}
