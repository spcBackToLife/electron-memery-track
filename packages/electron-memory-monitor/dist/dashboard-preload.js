"use strict";

// src/ipc/preload-api.ts
var import_electron = require("electron");

// src/ipc/channels.ts
var IPC_CHANNELS = {
  // === 数据推送（主进程 → 监控面板）===
  SNAPSHOT: "emm:snapshot",
  ANOMALY: "emm:anomaly",
  // === 会话控制（面板 → 主进程）===
  SESSION_START: "emm:session:start",
  SESSION_STOP: "emm:session:stop",
  SESSION_LIST: "emm:session:list",
  SESSION_REPORT: "emm:session:report",
  SESSION_COMPARE: "emm:session:compare",
  // === 数据查询（面板 → 主进程）===
  SESSION_SNAPSHOTS: "emm:session:snapshots",
  // === 工具操作（面板 → 主进程）===
  TRIGGER_GC: "emm:gc",
  HEAP_SNAPSHOT: "emm:heap-snapshot",
  MARK: "emm:mark",
  CONFIG_UPDATE: "emm:config:update",
  GET_CONFIG: "emm:config:get",
  GET_SESSIONS: "emm:sessions:get",
  // === 导入导出（面板 → 主进程）===
  SESSION_EXPORT: "emm:session:export",
  SESSION_IMPORT: "emm:session:import",
  SESSION_DELETE: "emm:session:delete",
  // === 渲染进程上报（可选）===
  RENDERER_REPORT: "emm:renderer:report",
  RENDERER_REQUEST: "emm:renderer:request"
};

// src/ipc/preload-api.ts
function injectMonitorPanelAPI() {
  const api = {
    // 会话控制
    startSession: (label, description) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_START, { label, description }),
    stopSession: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_STOP),
    getSessions: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.GET_SESSIONS),
    getSessionReport: (sessionId) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_REPORT, sessionId),
    compareSessions: (baseId, targetId) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMPARE, { baseId, targetId }),
    // 数据查询
    getSessionSnapshots: (sessionId, startTime, endTime, maxPoints) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_SNAPSHOTS, { sessionId, startTime, endTime, maxPoints }),
    // 导入导出
    exportSession: (sessionId) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT, sessionId),
    importSession: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_IMPORT),
    deleteSession: (sessionId) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
    // 工具
    triggerGC: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_GC),
    takeHeapSnapshot: (filePath) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.HEAP_SNAPSHOT, filePath),
    addMark: (label, metadata) => import_electron.ipcRenderer.invoke(IPC_CHANNELS.MARK, { label, metadata }),
    getConfig: () => import_electron.ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
    // 数据订阅
    onSnapshot: (callback) => {
      import_electron.ipcRenderer.on(IPC_CHANNELS.SNAPSHOT, (_event, data) => callback(data));
    },
    onAnomaly: (callback) => {
      import_electron.ipcRenderer.on(IPC_CHANNELS.ANOMALY, (_event, data) => callback(data));
    },
    // 移除监听器
    removeSnapshotListener: () => {
      import_electron.ipcRenderer.removeAllListeners(IPC_CHANNELS.SNAPSHOT);
    },
    removeAnomalyListener: () => {
      import_electron.ipcRenderer.removeAllListeners(IPC_CHANNELS.ANOMALY);
    }
  };
  import_electron.contextBridge.exposeInMainWorld("monitorAPI", api);
}

// src/core/dashboard-preload.ts
injectMonitorPanelAPI();
//# sourceMappingURL=dashboard-preload.js.map