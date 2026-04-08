// src/core/monitor.ts
import { app as app2 } from "electron";
import * as path3 from "path";
import * as v82 from "v8";
import { EventEmitter as EventEmitter3 } from "events";

// src/core/collector.ts
import { app, BrowserWindow, webContents } from "electron";
import * as v8 from "v8";
import * as os from "os";
import { EventEmitter } from "events";
var MemoryCollector = class extends EventEmitter {
  constructor(config) {
    super();
    this.timer = null;
    this.seq = 0;
    this.currentSessionId = null;
    this.pendingMarks = [];
    this.rendererDetails = /* @__PURE__ */ new Map();
    this.monitorWindowId = null;
    this.config = config;
  }
  /** 设置监控面板的 webContents ID，用于标记 */
  setMonitorWindowId(id) {
    this.monitorWindowId = id;
  }
  /** 设置当前会话 ID */
  setSessionId(sessionId) {
    this.currentSessionId = sessionId;
  }
  /** 添加事件标记 */
  addMark(label, metadata) {
    this.pendingMarks.push({
      timestamp: Date.now(),
      label,
      metadata
    });
  }
  /** 更新渲染进程 V8 详情 */
  updateRendererDetail(detail) {
    this.rendererDetails.set(detail.webContentsId, detail);
  }
  /** 开始采集 */
  start() {
    if (this.timer) return;
    this.collect();
    this.timer = setInterval(() => {
      this.collect();
    }, this.config.collectInterval);
  }
  /** 停止采集 */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** 执行一次采集 */
  collect() {
    try {
      const snapshot = this.buildSnapshot();
      this.emit("snapshot", snapshot);
    } catch (err) {
      this.emit("error", err);
    }
  }
  /** 构建完整的内存快照 */
  buildSnapshot() {
    const timestamp = Date.now();
    const processes = this.collectProcesses();
    const mainProcessMemory = this.collectMainProcessMemory();
    const mainProcessV8Detail = this.collectMainProcessV8Detail();
    const system = this.collectSystemMemory();
    const totalWorkingSetSize = processes.reduce(
      (sum, p) => p.isMonitorProcess ? sum : sum + p.memory.workingSetSize,
      0
    );
    const marks = this.pendingMarks.length > 0 ? [...this.pendingMarks] : void 0;
    this.pendingMarks = [];
    const rendererDetails = this.rendererDetails.size > 0 ? Array.from(this.rendererDetails.values()) : void 0;
    const snapshot = {
      timestamp,
      sessionId: this.currentSessionId ?? void 0,
      seq: this.seq++,
      processes,
      totalWorkingSetSize,
      mainProcessMemory,
      mainProcessV8Detail,
      system,
      rendererDetails,
      marks
    };
    return snapshot;
  }
  /** 采集所有进程信息 */
  collectProcesses() {
    const metrics = app.getAppMetrics();
    const wcList = webContents.getAllWebContents();
    const pidToWc = /* @__PURE__ */ new Map();
    for (const wc of wcList) {
      try {
        const pid = wc.getOSProcessId();
        pidToWc.set(pid, wc);
      } catch {
      }
    }
    const wcIdToTitle = /* @__PURE__ */ new Map();
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      try {
        wcIdToTitle.set(win.webContents.id, win.getTitle());
      } catch {
      }
    }
    return metrics.map((metric) => {
      const wc = pidToWc.get(metric.pid);
      let windowTitle;
      let webContentsId;
      let isMonitorProcess = false;
      if (wc) {
        webContentsId = wc.id;
        windowTitle = wcIdToTitle.get(wc.id);
        if (this.monitorWindowId !== null && wc.id === this.monitorWindowId) {
          isMonitorProcess = true;
          windowTitle = "[Memory Monitor]";
        }
      }
      let name = windowTitle;
      if (windowTitle && this.config.processLabels[windowTitle]) {
        name = this.config.processLabels[windowTitle];
      }
      const info = {
        pid: metric.pid,
        type: metric.type,
        name,
        isMonitorProcess,
        cpu: {
          percentCPUUsage: metric.cpu.percentCPUUsage,
          idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond
        },
        memory: {
          workingSetSize: metric.memory.workingSetSize,
          peakWorkingSetSize: metric.memory.peakWorkingSetSize,
          privateBytes: metric.memory.privateBytes
        },
        webContentsId,
        windowTitle
      };
      return info;
    });
  }
  /** 采集主进程 Node.js 内存 */
  collectMainProcessMemory() {
    const mem = process.memoryUsage();
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss
    };
  }
  /** 采集主进程 V8 详细统计 */
  collectMainProcessV8Detail() {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    let heapSpaces;
    if (this.config.enableV8HeapSpaces) {
      heapSpaces = v8.getHeapSpaceStatistics().map((space) => ({
        name: space.space_name ?? space.spaceName,
        size: space.space_size ?? space.spaceSize,
        usedSize: space.space_used_size ?? space.spaceUsedSize,
        availableSize: space.space_available_size ?? space.spaceAvailableSize,
        physicalSize: space.physical_space_size ?? space.physicalSpaceSize
      }));
    }
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss,
      totalHeapSize: heapStats.total_heap_size ?? heapStats.totalHeapSize,
      usedHeapSize: heapStats.used_heap_size ?? heapStats.usedHeapSize,
      heapSizeLimit: heapStats.heap_size_limit ?? heapStats.heapSizeLimit,
      mallocedMemory: heapStats.malloced_memory ?? heapStats.mallocedMemory,
      peakMallocedMemory: heapStats.peak_malloced_memory ?? heapStats.peakMallocedMemory,
      numberOfDetachedContexts: heapStats.number_of_detached_contexts ?? heapStats.numberOfDetachedContexts,
      numberOfNativeContexts: heapStats.number_of_native_contexts ?? heapStats.numberOfNativeContexts,
      heapSpaces
    };
  }
  /** 采集系统内存 */
  collectSystemMemory() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return {
      total,
      free,
      used,
      usagePercent: Math.round(used / total * 1e4) / 100
    };
  }
};

// src/core/persister.ts
import * as fs from "fs";
import * as path from "path";
var DataPersister = class {
  constructor(config, storageDir) {
    this.buffer = [];
    this.currentStream = null;
    this.currentDataFile = null;
    this.config = config;
    this.storageDir = storageDir;
    this.ensureDirectory(this.storageDir);
  }
  /** 获取存储目录 */
  getStorageDir() {
    return this.storageDir;
  }
  /** 创建新的会话数据文件 */
  createSessionFiles(sessionId) {
    const sessionDir = path.join(this.storageDir, sessionId);
    this.ensureDirectory(sessionDir);
    const dataFile = path.join(sessionDir, "snapshots.jsonl");
    const metaFile = path.join(sessionDir, "meta.json");
    this.closeStream();
    this.currentDataFile = dataFile;
    this.currentStream = fs.createWriteStream(dataFile, { flags: "a" });
    return { dataFile, metaFile };
  }
  /** 写入快照数据 */
  writeSnapshot(snapshot) {
    this.buffer.push(snapshot);
    if (this.buffer.length >= this.config.persistInterval) {
      this.flush();
    }
  }
  /** 刷新缓冲区到磁盘 */
  flush() {
    if (this.buffer.length === 0 || !this.currentStream) return;
    const lines = this.buffer.map((s) => JSON.stringify(s)).join("\n") + "\n";
    this.currentStream.write(lines);
    this.buffer = [];
  }
  /** 保存会话元信息 */
  saveSessionMeta(session) {
    const metaFile = path.join(this.storageDir, session.id, "meta.json");
    fs.writeFileSync(metaFile, JSON.stringify(session, null, 2), "utf-8");
    this.updateSessionIndex(session);
  }
  /** 读取会话元信息 */
  readSessionMeta(sessionId) {
    const metaFile = path.join(this.storageDir, sessionId, "meta.json");
    try {
      const content = fs.readFileSync(metaFile, "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  /** 获取所有会话列表 */
  getSessions() {
    const indexFile = path.join(this.storageDir, "sessions.json");
    try {
      const content = fs.readFileSync(indexFile, "utf-8");
      const index = JSON.parse(content);
      return index.sessions;
    } catch {
      return [];
    }
  }
  /** 读取会话的所有快照数据 */
  readSessionSnapshots(sessionId) {
    const dataFile = path.join(this.storageDir, sessionId, "snapshots.jsonl");
    try {
      const content = fs.readFileSync(dataFile, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
  /** 关闭流并刷新缓冲区 */
  close() {
    this.flush();
    this.closeStream();
  }
  /** 清理过期会话 */
  cleanOldSessions() {
    const sessions = this.getSessions();
    if (sessions.length <= this.config.storage.maxSessions) return;
    const toRemove = sessions.sort((a, b) => a.startTime - b.startTime).slice(0, sessions.length - this.config.storage.maxSessions);
    for (const session of toRemove) {
      const sessionDir = path.join(this.storageDir, session.id);
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch {
      }
    }
    const remaining = sessions.filter((s) => !toRemove.includes(s));
    this.saveSessionIndex(remaining);
  }
  /** 导出会话数据为单个 JSON 包 */
  exportSession(sessionId) {
    const meta = this.readSessionMeta(sessionId);
    const snapshotsFile = path.join(this.storageDir, sessionId, "snapshots.jsonl");
    const reportFile = path.join(this.storageDir, sessionId, "report.json");
    let snapshots = "";
    try {
      snapshots = fs.readFileSync(snapshotsFile, "utf-8");
    } catch {
    }
    let report = null;
    try {
      report = fs.readFileSync(reportFile, "utf-8");
    } catch {
    }
    return { meta, snapshots, report };
  }
  /** 导入会话数据 */
  importSession(data) {
    const { meta, snapshots, report } = data;
    const sessionDir = path.join(this.storageDir, meta.id);
    this.ensureDirectory(sessionDir);
    const snapshotsFile = path.join(sessionDir, "snapshots.jsonl");
    fs.writeFileSync(snapshotsFile, snapshots, "utf-8");
    meta.dataFile = snapshotsFile;
    meta.metaFile = path.join(sessionDir, "meta.json");
    fs.writeFileSync(meta.metaFile, JSON.stringify(meta, null, 2), "utf-8");
    if (report) {
      const reportFile = path.join(sessionDir, "report.json");
      fs.writeFileSync(reportFile, report, "utf-8");
    }
    this.updateSessionIndex(meta);
    return meta;
  }
  /** 删除指定会话 */
  deleteSession(sessionId) {
    const sessionDir = path.join(this.storageDir, sessionId);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      return false;
    }
    const sessions = this.getSessions().filter((s) => s.id !== sessionId);
    this.saveSessionIndex(sessions);
    return true;
  }
  // ===== 私有方法 =====
  closeStream() {
    if (this.currentStream) {
      this.currentStream.end();
      this.currentStream = null;
      this.currentDataFile = null;
    }
  }
  updateSessionIndex(session) {
    const sessions = this.getSessions();
    const existingIdx = sessions.findIndex((s) => s.id === session.id);
    if (existingIdx >= 0) {
      sessions[existingIdx] = session;
    } else {
      sessions.push(session);
    }
    this.saveSessionIndex(sessions);
  }
  saveSessionIndex(sessions) {
    const indexFile = path.join(this.storageDir, "sessions.json");
    const index = {
      sessions,
      lastUpdated: Date.now()
    };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf-8");
  }
  ensureDirectory(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
};

// src/core/utils.ts
function v4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = p / 100 * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function linearRegression(values, timestamps) {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0, intercept: values[0] || 0 };
  const t0 = timestamps[0];
  const xs = timestamps.map((t) => (t - t0) / 1e3);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((sum, x, i) => sum + x * values[i], 0);
  const sumX2 = xs.reduce((sum, x) => sum + x * x, 0);
  const sumY2 = values.reduce((sum, y) => sum + y * y, 0);
  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return { slope: 0, r2: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTotal = sumY2 - n * meanY * meanY;
  const ssResidual = values.reduce((sum, y, i) => {
    const predicted = intercept + slope * xs[i];
    return sum + (y - predicted) ** 2;
  }, 0);
  const r2 = ssTotal === 0 ? 0 : 1 - ssResidual / ssTotal;
  return { slope, r2, intercept };
}

// src/core/session.ts
var SessionManager = class {
  constructor(persister) {
    this.currentSession = null;
    this.persister = persister;
  }
  /** 获取当前正在运行的会话 */
  getCurrentSession() {
    return this.currentSession;
  }
  /** 开始新会话 */
  startSession(label, description) {
    if (this.currentSession && this.currentSession.status === "running") {
      this.endSession();
    }
    const sessionId = v4();
    const { dataFile, metaFile } = this.persister.createSessionFiles(sessionId);
    const session = {
      id: sessionId,
      label,
      description,
      startTime: Date.now(),
      status: "running",
      snapshotCount: 0,
      dataFile,
      metaFile
    };
    this.currentSession = session;
    this.persister.saveSessionMeta(session);
    return session;
  }
  /** 结束当前会话 */
  endSession() {
    if (!this.currentSession) return null;
    this.currentSession.endTime = Date.now();
    this.currentSession.duration = this.currentSession.endTime - this.currentSession.startTime;
    this.currentSession.status = "completed";
    this.persister.flush();
    this.persister.saveSessionMeta(this.currentSession);
    const session = { ...this.currentSession };
    this.currentSession = null;
    return session;
  }
  /** 增加当前会话的快照计数 */
  incrementSnapshotCount() {
    if (this.currentSession) {
      this.currentSession.snapshotCount++;
    }
  }
  /** 获取所有会话 */
  getSessions() {
    return this.persister.getSessions();
  }
  /** 获取指定会话 */
  getSession(sessionId) {
    return this.persister.readSessionMeta(sessionId);
  }
};

// src/core/anomaly.ts
import { EventEmitter as EventEmitter2 } from "events";
var AnomalyDetector = class extends EventEmitter2 {
  constructor(config) {
    super();
    this.snapshots = [];
    this.timer = null;
    this.maxWindowSize = 300;
    // 保留最近 300 条（5 分钟 @1s间隔）
    this.detectedAnomalies = [];
    this.config = config;
    this.builtinRules = this.createBuiltinRules();
  }
  /** 添加快照到检测窗口 */
  addSnapshot(snapshot) {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxWindowSize) {
      this.snapshots.shift();
    }
  }
  /** 获取所有检测到的异常 */
  getAnomalies() {
    return [...this.detectedAnomalies];
  }
  /** 清空异常记录 */
  clearAnomalies() {
    this.detectedAnomalies = [];
  }
  /** 开始定时检测 */
  start() {
    if (!this.config.anomaly.enabled || this.timer) return;
    this.timer = setInterval(() => {
      this.runDetection();
    }, this.config.anomaly.checkInterval);
  }
  /** 停止检测 */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /** 执行一次检测 */
  runDetection() {
    if (this.snapshots.length < 10) return;
    const latest = this.snapshots[this.snapshots.length - 1];
    const allRules = [...this.builtinRules, ...this.config.anomaly.rules];
    for (const rule of allRules) {
      if (!rule.enabled) continue;
      try {
        const anomaly = rule.detect(this.snapshots, latest);
        if (anomaly) {
          this.detectedAnomalies.push(anomaly);
          this.emit("anomaly", anomaly);
        }
      } catch {
      }
    }
  }
  /** 创建内置检测规则 */
  createBuiltinRules() {
    return [
      // 规则1：总内存持续增长
      {
        id: "continuous-growth",
        name: "\u603B\u5185\u5B58\u6301\u7EED\u589E\u957F",
        enabled: true,
        detect: (snapshots) => {
          if (snapshots.length < 60) return null;
          const values = snapshots.map((s) => s.totalWorkingSetSize);
          const timestamps = snapshots.map((s) => s.timestamp);
          const { slope, r2 } = linearRegression(values, timestamps);
          if (slope > 10 && r2 > 0.7) {
            return {
              id: v4(),
              timestamp: Date.now(),
              severity: r2 > 0.9 ? "critical" : "warning",
              category: "memory-leak",
              title: "\u603B\u5185\u5B58\u6301\u7EED\u589E\u957F",
              description: `\u5185\u5B58\u4EE5 ${slope.toFixed(2)} KB/s \u7684\u901F\u7387\u6301\u7EED\u589E\u957F (R\xB2=${r2.toFixed(3)})`,
              value: slope,
              threshold: 10
            };
          }
          return null;
        }
      },
      // 规则2：内存突增（spike）
      {
        id: "memory-spike",
        name: "\u5185\u5B58\u7A81\u589E",
        enabled: true,
        detect: (snapshots, latest) => {
          if (snapshots.length < 10) return null;
          const recentValues = snapshots.slice(-30).map((s) => s.totalWorkingSetSize);
          const avg = average(recentValues);
          const current = latest.totalWorkingSetSize;
          if (avg > 0 && (current - avg) / avg > 0.5) {
            return {
              id: v4(),
              timestamp: Date.now(),
              severity: "warning",
              category: "spike",
              title: "\u5185\u5B58\u7A81\u589E",
              description: `\u603B\u5185\u5B58\u4ECE ${Math.round(avg)} KB \u7A81\u589E\u5230 ${current} KB (+${((current - avg) / avg * 100).toFixed(1)}%)`,
              value: current,
              threshold: avg * 1.5
            };
          }
          return null;
        }
      },
      // 规则3：分离上下文检测
      {
        id: "detached-contexts",
        name: "\u5206\u79BB\u4E0A\u4E0B\u6587",
        enabled: true,
        detect: (_snapshots, latest) => {
          const detached = latest.mainProcessV8Detail?.numberOfDetachedContexts;
          if (detached && detached > 0) {
            return {
              id: v4(),
              timestamp: Date.now(),
              severity: "critical",
              category: "detached-context",
              title: `\u68C0\u6D4B\u5230 ${detached} \u4E2A\u5206\u79BB\u7684 V8 \u4E0A\u4E0B\u6587`,
              description: "\u5B58\u5728\u672A\u6B63\u786E\u9500\u6BC1\u7684 BrowserWindow \u6216 WebContents\uFF0C\u53EF\u80FD\u5BFC\u81F4\u5185\u5B58\u6CC4\u6F0F",
              value: detached,
              threshold: 0
            };
          }
          return null;
        }
      },
      // 规则4：V8 堆使用率过高
      {
        id: "heap-usage-high",
        name: "V8 \u5806\u4F7F\u7528\u7387\u8FC7\u9AD8",
        enabled: true,
        detect: (_snapshots, latest) => {
          const { heapUsed, heapTotal } = latest.mainProcessMemory;
          if (heapTotal > 0) {
            const usagePercent = heapUsed / heapTotal;
            if (usagePercent > 0.85) {
              return {
                id: v4(),
                timestamp: Date.now(),
                severity: usagePercent > 0.95 ? "critical" : "warning",
                category: "threshold",
                title: `V8 \u5806\u4F7F\u7528\u7387 ${(usagePercent * 100).toFixed(1)}%`,
                description: `\u4E3B\u8FDB\u7A0B V8 \u5806\u4F7F\u7528 ${Math.round(heapUsed / 1024 / 1024)} MB / ${Math.round(heapTotal / 1024 / 1024)} MB`,
                value: usagePercent * 100,
                threshold: 85
              };
            }
          }
          return null;
        }
      }
    ];
  }
};

// src/core/analyzer.ts
import * as os2 from "os";
var Analyzer = class {
  /** 生成会话报告 */
  generateReport(sessionId, label, description, startTime, endTime, snapshots, anomalies, dataFile) {
    if (snapshots.length === 0) {
      throw new Error("No snapshots to analyze");
    }
    const environment = this.collectEnvironment();
    const summary = this.computeSummary(snapshots);
    const suggestions = this.generateSuggestions(snapshots, summary, anomalies);
    return {
      sessionId,
      label,
      description,
      startTime,
      endTime,
      duration: endTime - startTime,
      environment,
      summary,
      anomalies,
      suggestions,
      dataFile
    };
  }
  /** 对比两个会话报告 */
  compareReports(base, target) {
    const overall = {
      totalMemory: this.diffMetric(base.summary.totalMemory, target.summary.totalMemory),
      browserMemory: this.diffMetric(base.summary.byProcessType.browser, target.summary.byProcessType.browser),
      rendererMemory: this.diffMetricArrayAvg(
        base.summary.byProcessType.renderer,
        target.summary.byProcessType.renderer
      ),
      gpuMemory: base.summary.byProcessType.gpu && target.summary.byProcessType.gpu ? this.diffMetric(base.summary.byProcessType.gpu, target.summary.byProcessType.gpu) : null
    };
    const v8Heap = {
      heapUsed: this.diffMetric(base.summary.mainV8Heap.heapUsed, target.summary.mainV8Heap.heapUsed),
      heapTotal: this.diffMetric(base.summary.mainV8Heap.heapTotal, target.summary.mainV8Heap.heapTotal),
      external: this.diffMetric(base.summary.mainV8Heap.external, target.summary.mainV8Heap.external)
    };
    const trendChanges = this.compareTrends(base.summary.trends, target.summary.trends);
    const regressions = this.findRegressions(overall, v8Heap);
    const improvements = this.findImprovements(overall, v8Heap);
    const { verdict, verdictReason } = this.determineVerdict(regressions, overall);
    return {
      base: { sessionId: base.sessionId, label: base.label },
      target: { sessionId: target.sessionId, label: target.label },
      overall,
      v8Heap,
      trendChanges,
      regressions,
      improvements,
      verdict,
      verdictReason
    };
  }
  // ===== 私有方法 =====
  collectEnvironment() {
    const cpus2 = os2.cpus();
    return {
      electronVersion: process.versions.electron || "unknown",
      chromeVersion: process.versions.chrome || "unknown",
      nodeVersion: process.versions.node || "unknown",
      platform: process.platform,
      arch: process.arch,
      totalSystemMemory: os2.totalmem(),
      cpuModel: cpus2.length > 0 ? cpus2[0].model : "unknown",
      cpuCores: cpus2.length
    };
  }
  computeSummary(snapshots) {
    const timestamps = snapshots.map((s) => s.timestamp);
    const processCounts = snapshots.map((s) => s.processes.length);
    const totalMemoryValues = snapshots.map((s) => s.totalWorkingSetSize);
    const browserValues = snapshots.map(
      (s) => s.processes.filter((p) => p.type === "Browser").reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    );
    const rendererSummaries = this.computeRendererSummaries(snapshots);
    const gpuValues = snapshots.map(
      (s) => s.processes.filter((p) => p.type === "GPU").reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    );
    const hasGpu = gpuValues.some((v) => v > 0);
    const utilityValues = snapshots.map(
      (s) => s.processes.filter((p) => p.type === "Utility").reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    );
    const hasUtility = utilityValues.some((v) => v > 0);
    const heapUsedValues = snapshots.map((s) => s.mainProcessMemory.heapUsed);
    const heapTotalValues = snapshots.map((s) => s.mainProcessMemory.heapTotal);
    const externalValues = snapshots.map((s) => s.mainProcessMemory.external);
    const arrayBufferValues = snapshots.map((s) => s.mainProcessMemory.arrayBuffers);
    const rendererTotalValues = snapshots.map(
      (s) => s.processes.filter((p) => p.type === "Tab" && !p.isMonitorProcess).reduce((sum, p) => sum + p.memory.workingSetSize, 0)
    );
    return {
      totalProcesses: {
        min: Math.min(...processCounts),
        max: Math.max(...processCounts),
        avg: Math.round(average(processCounts))
      },
      totalMemory: this.computeMetricSummary(totalMemoryValues),
      byProcessType: {
        browser: this.computeMetricSummary(browserValues),
        renderer: rendererSummaries,
        gpu: hasGpu ? this.computeMetricSummary(gpuValues) : null,
        utility: hasUtility ? this.computeMetricSummary(utilityValues) : null
      },
      mainV8Heap: {
        heapUsed: this.computeMetricSummary(heapUsedValues),
        heapTotal: this.computeMetricSummary(heapTotalValues),
        external: this.computeMetricSummary(externalValues),
        arrayBuffers: this.computeMetricSummary(arrayBufferValues)
      },
      trends: {
        totalMemory: this.computeTrend(totalMemoryValues, timestamps),
        browserMemory: this.computeTrend(browserValues, timestamps),
        rendererMemory: this.computeTrend(rendererTotalValues, timestamps)
      }
    };
  }
  computeRendererSummaries(snapshots) {
    const allPids = /* @__PURE__ */ new Set();
    for (const snapshot of snapshots) {
      for (const p of snapshot.processes) {
        if (p.type === "Tab" && !p.isMonitorProcess) {
          allPids.add(p.pid);
        }
      }
    }
    const summaries = [];
    for (const pid of allPids) {
      const values = snapshots.map((s) => {
        const proc = s.processes.find((p) => p.pid === pid);
        return proc ? proc.memory.workingSetSize : null;
      }).filter((v) => v !== null);
      if (values.length > 0) {
        summaries.push(this.computeMetricSummary(values));
      }
    }
    return summaries;
  }
  computeMetricSummary(values) {
    if (values.length === 0) {
      return { initial: 0, final: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, delta: 0, deltaPercent: 0 };
    }
    const initial = values[0];
    const final = values[values.length - 1];
    const delta = final - initial;
    const deltaPercent = initial !== 0 ? delta / initial * 100 : 0;
    return {
      initial,
      final,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round(average(values)),
      p50: Math.round(percentile(values, 50)),
      p95: Math.round(percentile(values, 95)),
      p99: Math.round(percentile(values, 99)),
      delta: Math.round(delta),
      deltaPercent: Math.round(deltaPercent * 100) / 100
    };
  }
  computeTrend(values, timestamps) {
    if (values.length < 10) {
      return { slope: 0, r2: 0, direction: "stable", confidence: "low" };
    }
    const { slope, r2 } = linearRegression(values, timestamps);
    let direction = "stable";
    if (slope > 1 && r2 > 0.3) direction = "growing";
    else if (slope < -1 && r2 > 0.3) direction = "shrinking";
    let confidence = "low";
    if (r2 > 0.8) confidence = "high";
    else if (r2 > 0.5) confidence = "medium";
    return { slope, r2, direction, confidence };
  }
  generateSuggestions(snapshots, summary, _anomalies) {
    const suggestions = [];
    const latest = snapshots[snapshots.length - 1];
    if (latest.mainProcessV8Detail?.numberOfDetachedContexts > 0) {
      suggestions.push({
        id: "detached-contexts",
        severity: "critical",
        category: "memory-leak",
        title: "\u68C0\u6D4B\u5230\u5206\u79BB\u7684 V8 \u4E0A\u4E0B\u6587 (Detached Contexts)",
        description: `\u53D1\u73B0 ${latest.mainProcessV8Detail.numberOfDetachedContexts} \u4E2A\u5206\u79BB\u4E0A\u4E0B\u6587\uFF0C\u901A\u5E38\u610F\u5473\u7740\u5B58\u5728\u672A\u6B63\u786E\u9500\u6BC1\u7684 BrowserWindow \u6216 WebContents \u5B9E\u4F8B\u3002`,
        suggestions: [
          "\u68C0\u67E5\u6240\u6709 BrowserWindow \u662F\u5426\u5728\u5173\u95ED\u65F6\u8C03\u7528\u4E86 destroy()",
          "\u68C0\u67E5\u662F\u5426\u6709\u95ED\u5305\u6301\u6709\u5DF2\u5173\u95ED\u7A97\u53E3\u7684 webContents \u5F15\u7528",
          '\u4F7F\u7528 Chrome DevTools Memory \u9762\u677F\u505A\u5806\u5FEB\u7167\uFF0C\u641C\u7D22 "Detached" \u5173\u952E\u5B57',
          "\u68C0\u67E5 ipcMain.on \u76D1\u542C\u5668\u662F\u5426\u5728\u7A97\u53E3\u5173\u95ED\u540E\u6B63\u786E\u79FB\u9664"
        ],
        relatedCode: [
          'win.on("closed", () => { win = null })',
          "win.destroy()  // \u800C\u4E0D\u4EC5\u4EC5\u662F win.close()"
        ]
      });
    }
    if (summary.trends.browserMemory.direction === "growing" && summary.trends.browserMemory.confidence === "high") {
      suggestions.push({
        id: "main-process-leak",
        severity: "warning",
        category: "memory-leak",
        title: "\u4E3B\u8FDB\u7A0B\u5185\u5B58\u5B58\u5728\u6301\u7EED\u589E\u957F\u8D8B\u52BF",
        description: `\u4E3B\u8FDB\u7A0B\u5185\u5B58\u4EE5 ${summary.trends.browserMemory.slope.toFixed(2)} KB/s \u7684\u901F\u7387\u589E\u957F (R\xB2=${summary.trends.browserMemory.r2.toFixed(3)})`,
        suggestions: [
          "\u68C0\u67E5\u4E3B\u8FDB\u7A0B\u4E2D\u662F\u5426\u6709\u672A\u6E05\u7406\u7684 setInterval/setTimeout",
          "\u68C0\u67E5 ipcMain.on \u662F\u5426\u5B58\u5728\u91CD\u590D\u6CE8\u518C",
          "\u68C0\u67E5\u662F\u5426\u6709\u6301\u7EED\u589E\u957F\u7684 Map/Set/Array \u7F13\u5B58\u672A\u8BBE\u7F6E\u4E0A\u9650",
          "\u68C0\u67E5 EventEmitter \u76D1\u542C\u5668\u662F\u5426\u6B63\u786E\u79FB\u9664",
          "\u8FD0\u884C --expose-gc \u5E76\u624B\u52A8\u89E6\u53D1 GC\uFF0C\u89C2\u5BDF\u5185\u5B58\u662F\u5426\u56DE\u843D"
        ]
      });
    }
    const highRenderers = summary.byProcessType.renderer.filter((r) => r.max > 300 * 1024);
    if (highRenderers.length > 0) {
      suggestions.push({
        id: "renderer-memory-high",
        severity: "warning",
        category: "optimization",
        title: "\u6E32\u67D3\u8FDB\u7A0B\u5185\u5B58\u5360\u7528\u8FC7\u9AD8",
        description: `\u6709 ${highRenderers.length} \u4E2A\u6E32\u67D3\u8FDB\u7A0B\u5185\u5B58\u5CF0\u503C\u8D85\u8FC7 300MB`,
        suggestions: [
          "\u68C0\u67E5\u662F\u5426\u52A0\u8F7D\u4E86\u8FC7\u5927\u7684\u56FE\u7247\u8D44\u6E90\uFF08\u8003\u8651\u61D2\u52A0\u8F7D/\u538B\u7F29\uFF09",
          "\u68C0\u67E5 DOM \u8282\u70B9\u6570\u91CF\uFF08\u8D85\u8FC7 1500 \u4E2A\u8282\u70B9\u4F1A\u663E\u8457\u589E\u52A0\u5185\u5B58\uFF09",
          "\u68C0\u67E5\u662F\u5426\u6709\u5927\u91CF\u672A\u9500\u6BC1\u7684 React \u7EC4\u4EF6\u5B9E\u4F8B",
          "\u8003\u8651\u4F7F\u7528\u865A\u62DF\u5217\u8868\uFF08Virtual List\uFF09\u66FF\u4EE3\u957F\u5217\u8868",
          "\u68C0\u67E5 Canvas/WebGL \u8D44\u6E90\u662F\u5426\u6B63\u786E\u91CA\u653E"
        ]
      });
    }
    const { heapUsed, heapTotal } = summary.mainV8Heap;
    if (heapTotal.avg > 0 && heapUsed.avg / heapTotal.avg > 0.8) {
      suggestions.push({
        id: "gc-ineffective",
        severity: "warning",
        category: "memory-leak",
        title: "V8 \u5806\u4F7F\u7528\u7387\u957F\u671F\u504F\u9AD8 (>80%)",
        description: "\u5806\u4F7F\u7528\u7387\u957F\u671F\u8D85\u8FC7 80%\uFF0CGC \u65E0\u6CD5\u6709\u6548\u91CA\u653E\u5185\u5B58\uFF0C\u7591\u4F3C\u5B58\u5728\u5185\u5B58\u6CC4\u6F0F",
        suggestions: [
          "\u5BFC\u51FA\u5806\u5FEB\u7167 (Heap Snapshot)\uFF0C\u4F7F\u7528 Chrome DevTools \u5206\u6790\u5BF9\u8C61\u7559\u5B58",
          '\u5BF9\u6BD4\u4E24\u4E2A\u65F6\u95F4\u70B9\u7684\u5806\u5FEB\u7167\uFF0C\u67E5\u627E "Allocated between snapshots" \u4E2D\u7684\u6CC4\u6F0F\u5BF9\u8C61',
          "\u68C0\u67E5 Event Listeners \u662F\u5426\u6B63\u786E\u6E05\u7406",
          "\u68C0\u67E5 Promise \u94FE\u662F\u5426\u6709\u672A\u5904\u7406\u7684 rejection \u5BFC\u81F4\u5F15\u7528\u672A\u91CA\u653E"
        ]
      });
    }
    if (summary.mainV8Heap.arrayBuffers.avg > 50 * 1024 * 1024) {
      suggestions.push({
        id: "arraybuffer-high",
        severity: "info",
        category: "optimization",
        title: "ArrayBuffer \u5185\u5B58\u5360\u7528\u504F\u9AD8",
        description: "ArrayBuffer \u5E73\u5747\u5360\u7528\u8D85\u8FC7 50MB",
        suggestions: [
          "\u68C0\u67E5 Buffer.alloc / Buffer.from \u7684\u4F7F\u7528\uFF0C\u786E\u4FDD\u7528\u5B8C\u540E\u4E0D\u518D\u6301\u6709\u5F15\u7528",
          "\u5982\u679C\u4F7F\u7528 IPC \u4F20\u8F93\u5927\u6570\u636E\uFF0C\u8003\u8651\u5206\u7247\u4F20\u8F93\u6216\u4F7F\u7528 MessagePort",
          "\u68C0\u67E5 Blob/File \u5BF9\u8C61\u662F\u5426\u53CA\u65F6\u91CA\u653E"
        ]
      });
    }
    if (summary.totalProcesses.max > 10) {
      suggestions.push({
        id: "too-many-processes",
        severity: "warning",
        category: "architecture",
        title: `\u8FDB\u7A0B\u6570\u91CF\u504F\u591A (\u6700\u9AD8 ${summary.totalProcesses.max} \u4E2A)`,
        description: "\u8FC7\u591A\u7684\u8FDB\u7A0B\u4F1A\u663E\u8457\u589E\u52A0\u5185\u5B58\u5F00\u9500",
        suggestions: [
          "\u68C0\u67E5\u662F\u5426\u521B\u5EFA\u4E86\u4E0D\u5FC5\u8981\u7684 BrowserWindow",
          "\u8003\u8651\u590D\u7528\u7A97\u53E3\u800C\u975E\u6BCF\u6B21\u521B\u5EFA\u65B0\u7A97\u53E3",
          "\u4F7F\u7528 webContents.setBackgroundThrottling(true) \u51CF\u5C11\u540E\u53F0\u8FDB\u7A0B\u5F00\u9500"
        ]
      });
    }
    if (latest.mainProcessV8Detail?.heapSpaces) {
      const oldSpace = latest.mainProcessV8Detail.heapSpaces.find((s) => s.name === "old_space");
      const totalUsed = latest.mainProcessV8Detail.heapSpaces.reduce((sum, s) => sum + s.usedSize, 0);
      if (oldSpace && totalUsed > 0 && oldSpace.usedSize / totalUsed > 0.85) {
        suggestions.push({
          id: "old-space-dominant",
          severity: "info",
          category: "optimization",
          title: "V8 old_space \u5360\u6BD4\u8D85\u8FC7 85%",
          description: "\u5927\u91CF\u5BF9\u8C61\u5B58\u6D3B\u5230 old generation\uFF0C\u53EF\u80FD\u5B58\u5728\u957F\u751F\u547D\u5468\u671F\u7684\u5927\u5BF9\u8C61\u6216\u7F13\u5B58\u672A\u56DE\u6536",
          suggestions: [
            "\u4F7F\u7528\u5806\u5FEB\u7167\u5206\u6790 old_space \u4E2D\u7684\u5927\u5BF9\u8C61",
            "\u68C0\u67E5\u5168\u5C40\u7F13\u5B58\u662F\u5426\u8BBE\u7F6E\u4E86\u8FC7\u671F\u7B56\u7565\u6216\u5BB9\u91CF\u4E0A\u9650",
            "\u8003\u8651\u4F7F\u7528 WeakMap/WeakRef \u66FF\u4EE3\u5F3A\u5F15\u7528\u7F13\u5B58",
            "\u68C0\u67E5\u95ED\u5305\u662F\u5426\u610F\u5916\u6301\u6709\u5927\u91CF\u5916\u90E8\u53D8\u91CF"
          ]
        });
      }
    }
    return suggestions;
  }
  diffMetric(base, target) {
    const delta = target.avg - base.avg;
    const deltaPercent = base.avg !== 0 ? delta / base.avg * 100 : 0;
    let status = "unchanged";
    if (deltaPercent > 3) status = "degraded";
    else if (deltaPercent < -3) status = "improved";
    let severity;
    if (Math.abs(deltaPercent) > 15) severity = "critical";
    else if (Math.abs(deltaPercent) > 5) severity = "major";
    else severity = "minor";
    return {
      base: base.avg,
      target: target.avg,
      delta: Math.round(delta),
      deltaPercent: Math.round(deltaPercent * 100) / 100,
      status,
      severity
    };
  }
  diffMetricArrayAvg(baseArr, targetArr) {
    const baseAvg = baseArr.length > 0 ? average(baseArr.map((s) => s.avg)) : 0;
    const targetAvg = targetArr.length > 0 ? average(targetArr.map((s) => s.avg)) : 0;
    const baseSummary = {
      initial: 0,
      final: 0,
      min: 0,
      max: 0,
      avg: baseAvg,
      p50: 0,
      p95: 0,
      p99: 0,
      delta: 0,
      deltaPercent: 0
    };
    const targetSummary = {
      initial: 0,
      final: 0,
      min: 0,
      max: 0,
      avg: targetAvg,
      p50: 0,
      p95: 0,
      p99: 0,
      delta: 0,
      deltaPercent: 0
    };
    return this.diffMetric(baseSummary, targetSummary);
  }
  compareTrends(baseTrends, targetTrends) {
    const metrics = ["totalMemory", "browserMemory", "rendererMemory"];
    return metrics.map((metric) => {
      const baseSlope = baseTrends[metric].slope;
      const targetSlope = targetTrends[metric].slope;
      let change = "unchanged";
      if (targetSlope > baseSlope + 1) change = "degraded";
      else if (targetSlope < baseSlope - 1) change = "improved";
      return { metric, baseSlope, targetSlope, change };
    });
  }
  findRegressions(overall, v8Heap) {
    const regressions = [];
    const checks = [
      { metric: "\u603B\u5185\u5B58", diff: overall.totalMemory, warnThreshold: 5, failThreshold: 15 },
      { metric: "\u4E3B\u8FDB\u7A0B\u5185\u5B58", diff: overall.browserMemory, warnThreshold: 10, failThreshold: 25 },
      { metric: "\u6E32\u67D3\u8FDB\u7A0B\u5185\u5B58", diff: overall.rendererMemory, warnThreshold: 10, failThreshold: 25 },
      { metric: "V8 Heap Used", diff: v8Heap.heapUsed, warnThreshold: 10, failThreshold: 30 }
    ];
    for (const check of checks) {
      if (check.diff.deltaPercent > check.warnThreshold) {
        regressions.push({
          metric: check.metric,
          description: `${check.metric}\u589E\u957F ${check.diff.deltaPercent.toFixed(1)}%`,
          baseValue: check.diff.base,
          targetValue: check.diff.target,
          deltaPercent: check.diff.deltaPercent,
          severity: check.diff.deltaPercent > check.failThreshold ? "critical" : "major",
          suggestion: `${check.metric}\u589E\u957F\u8D85\u8FC7\u9884\u671F\uFF0C\u5EFA\u8BAE\u68C0\u67E5\u65B0\u589E\u4EE3\u7801\u4E2D\u7684\u5185\u5B58\u4F7F\u7528`
        });
      }
    }
    return regressions;
  }
  findImprovements(overall, v8Heap) {
    const improvements = [];
    const checks = [
      { metric: "\u603B\u5185\u5B58", diff: overall.totalMemory },
      { metric: "\u4E3B\u8FDB\u7A0B\u5185\u5B58", diff: overall.browserMemory },
      { metric: "V8 Heap Used", diff: v8Heap.heapUsed }
    ];
    for (const check of checks) {
      if (check.diff.deltaPercent < -3) {
        improvements.push({
          metric: check.metric,
          description: `${check.metric}\u51CF\u5C11 ${Math.abs(check.diff.deltaPercent).toFixed(1)}%`,
          baseValue: check.diff.base,
          targetValue: check.diff.target,
          deltaPercent: check.diff.deltaPercent
        });
      }
    }
    return improvements;
  }
  determineVerdict(regressions, overall) {
    const critical = regressions.filter((r) => r.severity === "critical");
    const major = regressions.filter((r) => r.severity === "major");
    if (critical.length > 0) {
      return {
        verdict: "fail",
        verdictReason: `\u5B58\u5728 ${critical.length} \u9879\u4E25\u91CD\u52A3\u5316\uFF1A${critical.map((r) => r.metric).join("\u3001")}`
      };
    }
    if (major.length > 0 || overall.totalMemory.deltaPercent > 5) {
      return {
        verdict: "warn",
        verdictReason: `\u5B58\u5728 ${major.length} \u9879\u52A3\u5316\uFF0C\u603B\u5185\u5B58\u53D8\u5316 ${overall.totalMemory.deltaPercent.toFixed(1)}%`
      };
    }
    return {
      verdict: "pass",
      verdictReason: "\u6240\u6709\u5185\u5B58\u6307\u6807\u5728\u6B63\u5E38\u8303\u56F4\u5185"
    };
  }
};

// src/core/dashboard.ts
import { BrowserWindow as BrowserWindow2 } from "electron";
import * as path2 from "path";
var DashboardManager = class {
  constructor(config) {
    this.window = null;
    this.config = config;
  }
  /** 获取面板窗口 */
  getWindow() {
    return this.window;
  }
  /** 获取面板 webContents ID */
  getWebContentsId() {
    if (this.window && !this.window.isDestroyed()) {
      return this.window.webContents.id;
    }
    return null;
  }
  /** 打开监控面板 */
  open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }
    const preloadPath = path2.join(__dirname, "dashboard-preload.js");
    this.window = new BrowserWindow2({
      width: this.config.dashboard.width,
      height: this.config.dashboard.height,
      title: "Electron Memory Monitor",
      alwaysOnTop: this.config.dashboard.alwaysOnTop,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    const uiPath = path2.join(__dirname, "ui", "index.html");
    this.window.loadFile(uiPath);
    this.window.on("closed", () => {
      this.window = null;
    });
  }
  /** 关闭监控面板 */
  close() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
      this.window = null;
    }
  }
  /** 销毁面板 */
  destroy() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
      this.window = null;
    }
  }
};

// src/ipc/main-handler.ts
import { ipcMain } from "electron";

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

// src/ipc/main-handler.ts
var IPCMainHandler = class {
  constructor(monitor) {
    this.monitor = monitor;
  }
  /** 注册所有 IPC handlers */
  register() {
    ipcMain.handle(IPC_CHANNELS.SESSION_START, (_event, args) => {
      return this.monitor.startSession(args.label, args.description);
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_STOP, async () => {
      return this.monitor.stopSession();
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
      return this.monitor.getSessions();
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_REPORT, async (_event, sessionId) => {
      return this.monitor.getSessionReport(sessionId);
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_COMPARE, async (_event, args) => {
      return this.monitor.compareSessions(args.baseId, args.targetId);
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_SNAPSHOTS, async (_event, args) => {
      return this.monitor.getSessionSnapshots(args.sessionId, args.startTime, args.endTime, args.maxPoints);
    });
    ipcMain.handle(IPC_CHANNELS.TRIGGER_GC, async () => {
      return this.monitor.triggerGC();
    });
    ipcMain.handle(IPC_CHANNELS.HEAP_SNAPSHOT, async (_event, filePath) => {
      return this.monitor.takeHeapSnapshot(filePath);
    });
    ipcMain.handle(IPC_CHANNELS.MARK, (_event, args) => {
      this.monitor.mark(args.label, args.metadata);
    });
    ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
      return this.monitor.getConfig();
    });
    ipcMain.handle(IPC_CHANNELS.GET_SESSIONS, async () => {
      return this.monitor.getSessions();
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_event, sessionId) => {
      return this.monitor.exportSession(sessionId);
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async () => {
      return this.monitor.importSession();
    });
    ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId) => {
      return this.monitor.deleteSession(sessionId);
    });
    ipcMain.on(IPC_CHANNELS.RENDERER_REPORT, (_event, detail) => {
      this.monitor.updateRendererDetail(detail);
    });
  }
  /** 向监控面板推送快照数据 */
  pushSnapshot(dashboardWindow, data) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IPC_CHANNELS.SNAPSHOT, data);
    }
  }
  /** 向监控面板推送异常事件 */
  pushAnomaly(dashboardWindow, data) {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send(IPC_CHANNELS.ANOMALY, data);
    }
  }
  /** 移除所有注册的 handlers */
  unregister() {
    const channels = Object.values(IPC_CHANNELS);
    for (const channel of channels) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
  }
};

// src/types/config.ts
var DEFAULT_CONFIG = {
  enabled: true,
  autoStart: true,
  openDashboardOnStart: true,
  collectInterval: 2e3,
  persistInterval: 60,
  enableRendererDetail: false,
  enableV8HeapSpaces: true,
  anomaly: {
    enabled: true,
    checkInterval: 3e4,
    rules: []
  },
  storage: {
    directory: "",
    // 运行时由 app.getPath('userData') 填充
    maxSessions: 50,
    maxSessionDuration: 24 * 60 * 60 * 1e3
  },
  dashboard: {
    width: 1400,
    height: 900,
    alwaysOnTop: false
  },
  processLabels: {}
};

// src/core/monitor.ts
var ElectronMemoryMonitor = class extends EventEmitter3 {
  constructor(config) {
    super();
    this.started = false;
    this.latestSnapshot = null;
    this.config = this.mergeConfig(config);
    if (!this.config.enabled) {
      this.collector = null;
      this.anomalyDetector = null;
      this.analyzer = null;
      this.dashboard = null;
      return;
    }
    this.collector = new MemoryCollector(this.config);
    this.anomalyDetector = new AnomalyDetector(this.config);
    this.analyzer = new Analyzer();
    this.dashboard = new DashboardManager(this.config);
    if (this.config.autoStart) {
      this.start();
    }
  }
  // ============ 生命周期 ============
  /** 启动监控 */
  async start() {
    if (!this.config.enabled || this.started) return;
    if (!app2.isReady()) {
      await app2.whenReady();
    }
    const storageDir = this.config.storage.directory || path3.join(app2.getPath("userData"), "memory-monitor");
    this.persister = new DataPersister(this.config, storageDir);
    this.sessionManager = new SessionManager(this.persister);
    this.ipcHandler = new IPCMainHandler(this);
    this.ipcHandler.register();
    this.collector.on("snapshot", (snapshot) => {
      this.onSnapshot(snapshot);
    });
    this.anomalyDetector.on("anomaly", (anomaly) => {
      this.emit("anomaly", anomaly);
      this.ipcHandler.pushAnomaly(this.dashboard.getWindow(), anomaly);
    });
    this.collector.start();
    this.anomalyDetector.start();
    if (this.config.openDashboardOnStart) {
      this.openDashboard();
    }
    this.persister.cleanOldSessions();
    this.started = true;
  }
  /** 停止监控 */
  async stop() {
    if (!this.started) return;
    this.collector.stop();
    this.anomalyDetector.stop();
    const currentSession = this.sessionManager.getCurrentSession();
    if (currentSession) {
      await this.stopSession();
    }
    this.persister.close();
    this.started = false;
  }
  /** 销毁实例 */
  async destroy() {
    await this.stop();
    this.dashboard.destroy();
    if (this.ipcHandler) {
      this.ipcHandler.unregister();
    }
    this.removeAllListeners();
  }
  // ============ 会话控制 ============
  /** 开始新会话 */
  startSession(label, description) {
    if (!this.started) {
      throw new Error("Monitor is not started");
    }
    const session = this.sessionManager.startSession(label, description);
    this.collector.setSessionId(session.id);
    this.anomalyDetector.clearAnomalies();
    return session.id;
  }
  /** 结束当前会话 */
  async stopSession() {
    if (!this.started) return null;
    const session = this.sessionManager.getCurrentSession();
    if (!session) return null;
    const completedSession = this.sessionManager.endSession();
    if (!completedSession) return null;
    this.collector.setSessionId(null);
    const snapshots = this.persister.readSessionSnapshots(completedSession.id);
    const anomalies = this.anomalyDetector.getAnomalies();
    const report = this.analyzer.generateReport(
      completedSession.id,
      completedSession.label,
      completedSession.description,
      completedSession.startTime,
      completedSession.endTime,
      snapshots,
      anomalies,
      completedSession.dataFile
    );
    const reportPath = path3.join(this.persister.getStorageDir(), completedSession.id, "report.json");
    const fs2 = await import("fs");
    fs2.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    this.emit("session-end", report);
    return report;
  }
  // ============ 监控面板 ============
  /** 打开监控面板 */
  openDashboard() {
    this.dashboard.open();
    const wcId = this.dashboard.getWebContentsId();
    this.collector.setMonitorWindowId(wcId);
  }
  /** 关闭监控面板 */
  closeDashboard() {
    this.dashboard.close();
    this.collector.setMonitorWindowId(null);
  }
  // ============ 数据访问 ============
  /** 获取当前最新快照 */
  getCurrentSnapshot() {
    return this.latestSnapshot;
  }
  /** 获取历史会话列表 */
  async getSessions() {
    return this.sessionManager.getSessions();
  }
  /** 获取指定会话报告 */
  async getSessionReport(sessionId) {
    const fs2 = await import("fs");
    const reportPath = path3.join(this.persister.getStorageDir(), sessionId, "report.json");
    try {
      const content = fs2.readFileSync(reportPath, "utf-8");
      return JSON.parse(content);
    } catch {
      const session = this.sessionManager.getSession(sessionId);
      if (!session || !session.endTime) return null;
      const snapshots = this.persister.readSessionSnapshots(sessionId);
      if (snapshots.length === 0) return null;
      return this.analyzer.generateReport(
        session.id,
        session.label,
        session.description,
        session.startTime,
        session.endTime,
        snapshots,
        [],
        session.dataFile
      );
    }
  }
  /** 获取指定会话的快照数据（支持时间过滤和降采样） */
  async getSessionSnapshots(sessionId, startTime, endTime, maxPoints) {
    let snapshots = this.persister.readSessionSnapshots(sessionId);
    if (startTime != null) {
      snapshots = snapshots.filter((s) => s.timestamp >= startTime);
    }
    if (endTime != null) {
      snapshots = snapshots.filter((s) => s.timestamp <= endTime);
    }
    const limit = maxPoints ?? 600;
    if (snapshots.length > limit) {
      const step = snapshots.length / limit;
      const sampled = [];
      for (let i = 0; i < limit; i++) {
        sampled.push(snapshots[Math.round(i * step)]);
      }
      if (sampled[sampled.length - 1] !== snapshots[snapshots.length - 1]) {
        sampled[sampled.length - 1] = snapshots[snapshots.length - 1];
      }
      snapshots = sampled;
    }
    return snapshots;
  }
  /** 对比两个会话 */
  async compareSessions(baseId, targetId) {
    const baseReport = await this.getSessionReport(baseId);
    const targetReport = await this.getSessionReport(targetId);
    if (!baseReport || !targetReport) return null;
    return this.analyzer.compareReports(baseReport, targetReport);
  }
  /** 导出会话数据（供 IPC 调用，弹出保存对话框） */
  async exportSession(sessionId) {
    try {
      const { dialog } = await import("electron");
      const session = this.sessionManager.getSession(sessionId);
      if (!session) return { success: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
      const defaultName = `emm-${session.label.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_")}-${new Date(session.startTime).toISOString().slice(0, 10)}.emmsession`;
      const result = await dialog.showSaveDialog({
        title: "\u5BFC\u51FA\u4F1A\u8BDD\u6570\u636E",
        defaultPath: defaultName,
        filters: [
          { name: "EMM Session", extensions: ["emmsession"] },
          { name: "JSON \u6587\u4EF6", extensions: ["json"] },
          { name: "\u6240\u6709\u6587\u4EF6", extensions: ["*"] }
        ]
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: "\u7528\u6237\u53D6\u6D88" };
      }
      const exportData = this.persister.exportSession(sessionId);
      const fs2 = await import("fs");
      const fileContent = JSON.stringify({
        version: 1,
        exportTime: Date.now(),
        ...exportData
      }, null, 2);
      fs2.writeFileSync(result.filePath, fileContent, "utf-8");
      return { success: true, filePath: result.filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /** 导入会话数据（供 IPC 调用，弹出打开对话框） */
  async importSession() {
    try {
      const { dialog } = await import("electron");
      const result = await dialog.showOpenDialog({
        title: "\u5BFC\u5165\u4F1A\u8BDD\u6570\u636E",
        filters: [
          { name: "EMM Session", extensions: ["emmsession"] },
          { name: "JSON \u6587\u4EF6", extensions: ["json"] },
          { name: "\u6240\u6709\u6587\u4EF6", extensions: ["*"] }
        ],
        properties: ["openFile"]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: "\u7528\u6237\u53D6\u6D88" };
      }
      const fs2 = await import("fs");
      const content = fs2.readFileSync(result.filePaths[0], "utf-8");
      const parsed = JSON.parse(content);
      if (!parsed.meta || !parsed.snapshots) {
        return { success: false, error: "\u6587\u4EF6\u683C\u5F0F\u4E0D\u6B63\u786E\uFF0C\u7F3A\u5C11 meta \u6216 snapshots \u6570\u636E" };
      }
      const session = this.persister.importSession({
        meta: parsed.meta,
        snapshots: parsed.snapshots,
        report: parsed.report || null
      });
      return { success: true, session };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }
  /** 删除指定会话 */
  async deleteSession(sessionId) {
    return this.persister.deleteSession(sessionId);
  }
  // ============ 工具方法 ============
  /** 手动触发 GC */
  async triggerGC() {
    const beforeMem = process.memoryUsage();
    if (global.gc) {
      global.gc();
    } else {
      try {
        v82.writeHeapSnapshot;
      } catch {
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterMem = process.memoryUsage();
    const freed = beforeMem.heapUsed - afterMem.heapUsed;
    return {
      beforeHeapUsed: beforeMem.heapUsed,
      afterHeapUsed: afterMem.heapUsed,
      freed,
      freedPercent: beforeMem.heapUsed > 0 ? freed / beforeMem.heapUsed * 100 : 0,
      timestamp: Date.now()
    };
  }
  /** 导出堆快照 */
  async takeHeapSnapshot(filePath) {
    const snapshotPath = filePath || path3.join(
      this.persister.getStorageDir(),
      `heap-${Date.now()}.heapsnapshot`
    );
    v82.writeHeapSnapshot(snapshotPath);
    return snapshotPath;
  }
  /** 添加事件标记 */
  mark(label, metadata) {
    this.collector.addMark(label, metadata);
  }
  /** 更新渲染进程 V8 详情 */
  updateRendererDetail(detail) {
    this.collector.updateRendererDetail(detail);
  }
  /** 获取当前配置 */
  getConfig() {
    return { ...this.config };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event, handler) {
    return super.on(event, handler);
  }
  // ============ 私有方法 ============
  onSnapshot(snapshot) {
    this.latestSnapshot = snapshot;
    if (this.sessionManager.getCurrentSession()) {
      this.persister.writeSnapshot(snapshot);
      this.sessionManager.incrementSnapshotCount();
    }
    this.anomalyDetector.addSnapshot(snapshot);
    this.ipcHandler?.pushSnapshot(this.dashboard.getWindow(), snapshot);
    this.emit("snapshot", snapshot);
  }
  mergeConfig(userConfig) {
    if (!userConfig) return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      anomaly: {
        ...DEFAULT_CONFIG.anomaly,
        ...userConfig.anomaly || {}
      },
      storage: {
        ...DEFAULT_CONFIG.storage,
        ...userConfig.storage || {}
      },
      dashboard: {
        ...DEFAULT_CONFIG.dashboard,
        ...userConfig.dashboard || {}
      },
      processLabels: {
        ...DEFAULT_CONFIG.processLabels,
        ...userConfig.processLabels || {}
      }
    };
  }
};
export {
  ElectronMemoryMonitor,
  IPC_CHANNELS
};
//# sourceMappingURL=index.mjs.map