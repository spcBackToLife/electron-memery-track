"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/preload/inject.ts
var inject_exports = {};
__export(inject_exports, {
  injectRendererReporter: () => injectRendererReporter
});
module.exports = __toCommonJS(inject_exports);
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

// src/preload/inject.ts
function injectRendererReporter(interval = 2e3) {
  let timer = null;
  const report = () => {
    try {
      const mem = process.memoryUsage();
      import_electron.ipcRenderer.send(IPC_CHANNELS.RENDERER_REPORT, {
        webContentsId: -1,
        // 由主进程根据 sender 重写
        pid: process.pid,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers
      });
    } catch {
    }
  };
  import_electron.ipcRenderer.on(IPC_CHANNELS.RENDERER_REQUEST, () => {
    report();
  });
  timer = setInterval(report, interval);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    import_electron.ipcRenderer.removeAllListeners(IPC_CHANNELS.RENDERER_REQUEST);
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  injectRendererReporter
});
//# sourceMappingURL=preload.js.map