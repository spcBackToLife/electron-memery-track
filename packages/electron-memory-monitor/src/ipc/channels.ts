/**
 * IPC 通道常量定义
 * 所有通道以 'emm:' 为前缀，避免与业务 IPC 冲突
 */

export const IPC_CHANNELS = {
  // === 数据推送（主进程 → 监控面板）===
  SNAPSHOT: 'emm:snapshot',
  ANOMALY: 'emm:anomaly',

  // === 会话控制（面板 → 主进程）===
  SESSION_START: 'emm:session:start',
  SESSION_STOP: 'emm:session:stop',
  SESSION_LIST: 'emm:session:list',
  SESSION_REPORT: 'emm:session:report',
  SESSION_COMPARE: 'emm:session:compare',

  // === 数据查询（面板 → 主进程）===
  SESSION_SNAPSHOTS: 'emm:session:snapshots',

  // === 工具操作（面板 → 主进程）===
  TRIGGER_GC: 'emm:gc',
  HEAP_SNAPSHOT: 'emm:heap-snapshot',
  MARK: 'emm:mark',
  CONFIG_UPDATE: 'emm:config:update',
  GET_CONFIG: 'emm:config:get',
  GET_SESSIONS: 'emm:sessions:get',

  // === 导入导出（面板 → 主进程）===
  SESSION_EXPORT: 'emm:session:export',
  SESSION_IMPORT: 'emm:session:import',
  SESSION_DELETE: 'emm:session:delete',

  // === 渲染进程上报（可选）===
  RENDERER_REPORT: 'emm:renderer:report',
  RENDERER_REQUEST: 'emm:renderer:request',
} as const
