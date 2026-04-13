// src/preload/inject.ts
import { ipcRenderer } from "electron";

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
  if (typeof process === "undefined" || typeof process.memoryUsage !== "function") {
    console.warn(
      "[@electron-memory/monitor] injectRendererReporter \u9700\u8981 Node \u7684 process.memoryUsage\u3002Electron \u5728 webPreferences.sandbox=true\uFF08\u6216\u9ED8\u8BA4\u6C99\u7BB1\uFF09\u7684 preload \u91CC\u4E0D\u63D0\u4F9B process\uFF0C\u4E0A\u62A5\u4E0D\u4F1A\u751F\u6548\u3002\u8BF7\u5C06\u4E1A\u52A1 WebContents \u8BBE\u4E3A sandbox: false\uFF0C\u6216\u4E3A\u8BE5\u7A97\u53E3\u5173\u95ED\u6C99\u7BB1\u3002"
    );
    return () => {
    };
  }
  let timer = null;
  const report = () => {
    try {
      const mem = process.memoryUsage();
      ipcRenderer.send(IPC_CHANNELS.RENDERER_REPORT, {
        webContentsId: -1,
        // 由主进程根据 sender 重写
        pid: process.pid,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers
      });
    } catch (err) {
      console.warn("[@electron-memory/monitor] injectRendererReporter \u4E0A\u62A5\u5931\u8D25:", err);
    }
  };
  ipcRenderer.on(IPC_CHANNELS.RENDERER_REQUEST, () => {
    report();
  });
  timer = setInterval(report, interval);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    ipcRenderer.removeAllListeners(IPC_CHANNELS.RENDERER_REQUEST);
  };
}
export {
  injectRendererReporter
};
//# sourceMappingURL=preload.mjs.map