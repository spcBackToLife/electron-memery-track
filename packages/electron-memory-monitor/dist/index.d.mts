import { EventEmitter } from 'events';

/**
 * 内存快照数据结构
 * 每次采集产出一个 MemorySnapshot，包含所有进程的内存信息
 */
/** 单个进程的内存信息 */
interface ProcessMemoryInfo {
    /** 进程 PID */
    pid: number;
    /** 进程类型：Browser(主进程) / Tab(渲染进程) / GPU / Utility */
    type: 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Zygote' | string;
    /** 用户可读的进程名称（如窗口标题） */
    name?: string;
    /** 是否是监控面板自身的进程 */
    isMonitorProcess?: boolean;
    /** 来自 app.getAppMetrics() */
    cpu: {
        percentCPUUsage: number;
        idleWakeupsPerSecond: number;
    };
    memory: {
        /** 工作集大小 (KB) - 进程实际使用的物理内存 */
        workingSetSize: number;
        /** 峰值工作集 (KB) */
        peakWorkingSetSize: number;
        /** 私有字节 (KB) - 不与其他进程共享的内存 */
        privateBytes?: number;
    };
    /** 仅渲染进程：关联的 webContents ID */
    webContentsId?: number;
    /** 仅渲染进程：窗口标题 */
    windowTitle?: string;
}
/** 主进程 V8 堆统计 */
interface V8HeapStats {
    /** 已使用堆大小 (bytes) */
    heapUsed: number;
    /** 堆总大小 (bytes) */
    heapTotal: number;
    /** V8 外部内存 (bytes) */
    external: number;
    /** ArrayBuffers 占用 (bytes) */
    arrayBuffers: number;
    /** RSS (bytes) */
    rss: number;
}
/** V8 堆详细统计 */
interface V8HeapDetailStats extends V8HeapStats {
    /** V8 总堆大小 */
    totalHeapSize: number;
    /** V8 已使用堆大小 */
    usedHeapSize: number;
    /** V8 堆大小限制 */
    heapSizeLimit: number;
    /** V8 malloc 已分配内存 */
    mallocedMemory: number;
    /** V8 malloc 峰值 */
    peakMallocedMemory: number;
    /** 分离的上下文数 - 泄漏关键信号 */
    numberOfDetachedContexts: number;
    /** 原生上下文数 */
    numberOfNativeContexts: number;
    /** 堆空间详情 */
    heapSpaces?: V8HeapSpaceInfo[];
}
/** V8 堆空间信息 */
interface V8HeapSpaceInfo {
    name: string;
    size: number;
    usedSize: number;
    availableSize: number;
    physicalSize: number;
}
/** 系统内存信息 */
interface SystemMemoryInfo {
    /** 总物理内存 (bytes) */
    total: number;
    /** 可用物理内存 (bytes) */
    free: number;
    /** 已使用物理内存 (bytes) */
    used: number;
    /** 使用率 (0-100) */
    usagePercent: number;
}
/** 渲染进程 V8 详情（需要 preload 注入） */
interface RendererV8Detail {
    webContentsId: number;
    pid: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
}
/** 事件标记 */
interface EventMark {
    timestamp: number;
    label: string;
    metadata?: Record<string, unknown>;
}
/** 完整的内存快照 */
interface MemorySnapshot {
    /** 快照时间戳 (ms) */
    timestamp: number;
    /** 所属会话 ID */
    sessionId?: string;
    /** 快照序号 */
    seq: number;
    /** 所有进程的内存信息 */
    processes: ProcessMemoryInfo[];
    /** 所有进程的总工作集大小 (KB) */
    totalWorkingSetSize: number;
    /** 主进程 V8 堆统计 */
    mainProcessMemory: V8HeapStats;
    /** 主进程 V8 详细统计 */
    mainProcessV8Detail: V8HeapDetailStats;
    /** 系统内存信息 */
    system: SystemMemoryInfo;
    /** 渲染进程 V8 详情（可选，需要 preload 注入） */
    rendererDetails?: RendererV8Detail[];
    /** 事件标记 */
    marks?: EventMark[];
}

/**
 * 异常检测相关类型
 */
/** 异常严重级别 */
type AnomalySeverity = 'info' | 'warning' | 'critical';
/** 异常类别 */
type AnomalyCategory = 'memory-leak' | 'spike' | 'threshold' | 'detached-context' | 'trend';
/** 异常事件 */
interface AnomalyEvent {
    /** 事件 ID */
    id: string;
    /** 发现时间 */
    timestamp: number;
    /** 严重级别 */
    severity: AnomalySeverity;
    /** 类别 */
    category: AnomalyCategory;
    /** 涉及的进程类型 */
    processType?: string;
    /** 涉及的进程 PID */
    pid?: number;
    /** 标题 */
    title: string;
    /** 详细描述 */
    description: string;
    /** 触发值 */
    value?: number;
    /** 阈值 */
    threshold?: number;
}
/** 异常检测规则 */
interface AnomalyRule {
    /** 规则 ID */
    id: string;
    /** 规则名称 */
    name: string;
    /** 是否启用 */
    enabled: boolean;
    /** 检测函数 */
    detect: (snapshots: MemorySnapshot[], latestSnapshot: MemorySnapshot) => AnomalyEvent | null;
}

/**
 * SDK 配置类型
 */

interface MonitorConfig {
    /** 总开关，默认 true */
    enabled: boolean;
    /** 实例化后是否自动开始采集，默认 true */
    autoStart: boolean;
    /** 启动后是否自动打开监控面板，默认 true */
    openDashboardOnStart: boolean;
    /** 采集间隔 (ms)，默认 2000 */
    collectInterval: number;
    /** 落盘间隔 (条数)，默认 60 */
    persistInterval: number;
    /** 是否采集渲染进程 V8 详情（需要 preload 配合），默认 false */
    enableRendererDetail: boolean;
    /** 是否采集 V8 堆空间详情，默认 true */
    enableV8HeapSpaces: boolean;
    anomaly: {
        /** 是否启用异常检测，默认 true */
        enabled: boolean;
        /** 检测间隔 (ms)，默认 30000 */
        checkInterval: number;
        /** 自定义检测规则（追加到内置规则） */
        rules: AnomalyRule[];
    };
    storage: {
        /** 数据存储目录，默认 app.getPath('userData') + '/memory-monitor' */
        directory: string;
        /** 最大保留会话数，默认 50 */
        maxSessions: number;
        /** 单次会话最大时长 (ms)，默认 24h */
        maxSessionDuration: number;
    };
    dashboard: {
        /** 窗口宽度，默认 1400 */
        width: number;
        /** 窗口高度，默认 900 */
        height: number;
        /** 是否置顶，默认 false */
        alwaysOnTop: boolean;
    };
    /** 给窗口进程打标签，方便识别 */
    processLabels: Record<string, string>;
}

/**
 * 测试会话相关类型
 */
interface TestSession {
    /** 会话唯一 ID */
    id: string;
    /** 用户标签，如 "v1.2.0-空载基准" */
    label: string;
    /** 描述 */
    description?: string;
    /** 开始时间 (ms) */
    startTime: number;
    /** 结束时间 (ms) */
    endTime?: number;
    /** 持续时长 (ms) */
    duration?: number;
    /** 状态 */
    status: 'running' | 'completed' | 'aborted';
    /** 快照数量 */
    snapshotCount: number;
    /** 数据文件路径 */
    dataFile: string;
    /** 元数据文件路径 */
    metaFile: string;
}
/** 会话索引（存在 sessions.json 中） */
interface SessionIndex {
    sessions: TestSession[];
    lastUpdated: number;
}

/**
 * 报告与对比相关类型
 */

/** 指标统计摘要 */
interface MetricSummary {
    /** 首次采样值 */
    initial: number;
    /** 最后采样值 */
    final: number;
    min: number;
    max: number;
    avg: number;
    /** 中位数 */
    p50: number;
    p95: number;
    p99: number;
    /** 变化量 final - initial */
    delta: number;
    /** 变化百分比 */
    deltaPercent: number;
}
/** 趋势信息 */
interface TrendInfo {
    /** 线性回归斜率 (bytes/s) */
    slope: number;
    /** 拟合优度 (0~1) */
    r2: number;
    /** 趋势方向 */
    direction: 'stable' | 'growing' | 'shrinking';
    /** 置信度 */
    confidence: 'high' | 'medium' | 'low';
}
/** 改进建议 */
interface Suggestion {
    /** 建议 ID */
    id: string;
    /** 严重级别 */
    severity: 'info' | 'warning' | 'critical';
    /** 类别 */
    category: 'memory-leak' | 'optimization' | 'architecture';
    /** 标题 */
    title: string;
    /** 描述 */
    description: string;
    /** 具体建议步骤 */
    suggestions: string[];
    /** 相关代码示例 */
    relatedCode?: string[];
}
/** 会话报告 */
interface SessionReport {
    sessionId: string;
    label: string;
    description?: string;
    startTime: number;
    endTime: number;
    duration: number;
    environment: {
        electronVersion: string;
        chromeVersion: string;
        nodeVersion: string;
        platform: string;
        arch: string;
        totalSystemMemory: number;
        cpuModel: string;
        cpuCores: number;
    };
    summary: {
        totalProcesses: {
            min: number;
            max: number;
            avg: number;
        };
        totalMemory: MetricSummary;
        byProcessType: {
            browser: MetricSummary;
            renderer: MetricSummary[];
            gpu: MetricSummary | null;
            utility: MetricSummary | null;
        };
        mainV8Heap: {
            heapUsed: MetricSummary;
            heapTotal: MetricSummary;
            external: MetricSummary;
            arrayBuffers: MetricSummary;
        };
        trends: {
            totalMemory: TrendInfo;
            browserMemory: TrendInfo;
            rendererMemory: TrendInfo;
        };
    };
    anomalies: AnomalyEvent[];
    suggestions: Suggestion[];
    dataFile: string;
}
/** 指标差异 */
interface MetricDiff {
    base: number;
    target: number;
    delta: number;
    deltaPercent: number;
    status: 'improved' | 'degraded' | 'unchanged';
    severity?: 'minor' | 'major' | 'critical';
}
/** 劣化项 */
interface Regression {
    metric: string;
    description: string;
    baseValue: number;
    targetValue: number;
    deltaPercent: number;
    severity: 'minor' | 'major' | 'critical';
    suggestion: string;
}
/** 改进项 */
interface Improvement {
    metric: string;
    description: string;
    baseValue: number;
    targetValue: number;
    deltaPercent: number;
}
/** 对比报告 */
interface CompareReport {
    base: {
        sessionId: string;
        label: string;
    };
    target: {
        sessionId: string;
        label: string;
    };
    overall: {
        totalMemory: MetricDiff;
        browserMemory: MetricDiff;
        rendererMemory: MetricDiff;
        gpuMemory: MetricDiff | null;
    };
    v8Heap: {
        heapUsed: MetricDiff;
        heapTotal: MetricDiff;
        external: MetricDiff;
    };
    trendChanges: {
        metric: string;
        baseSlope: number;
        targetSlope: number;
        change: 'improved' | 'degraded' | 'unchanged';
    }[];
    regressions: Regression[];
    improvements: Improvement[];
    verdict: 'pass' | 'warn' | 'fail';
    verdictReason: string;
}
/** GC 结果 */
interface GCResult {
    beforeHeapUsed: number;
    afterHeapUsed: number;
    freed: number;
    freedPercent: number;
    timestamp: number;
}

/**
 * ElectronMemoryMonitor - SDK 主入口
 *
 * 门面类（Facade Pattern），提供简洁的 API
 * 一行代码即可接入：new ElectronMemoryMonitor()
 */

declare class ElectronMemoryMonitor extends EventEmitter {
    private config;
    private collector;
    private persister;
    private sessionManager;
    private anomalyDetector;
    private analyzer;
    private dashboard;
    private ipcHandler;
    private started;
    private latestSnapshot;
    constructor(config?: Partial<MonitorConfig>);
    /** 启动监控 */
    start(): Promise<void>;
    /** 停止监控 */
    stop(): Promise<void>;
    /** 销毁实例 */
    destroy(): Promise<void>;
    /** 开始新会话 */
    startSession(label: string, description?: string): string;
    /** 结束当前会话 */
    stopSession(): Promise<SessionReport | null>;
    /** 打开监控面板 */
    openDashboard(): void;
    /** 关闭监控面板 */
    closeDashboard(): void;
    /** 获取当前最新快照 */
    getCurrentSnapshot(): MemorySnapshot | null;
    /** 获取历史会话列表 */
    getSessions(): Promise<TestSession[]>;
    /** 获取指定会话报告 */
    getSessionReport(sessionId: string): Promise<SessionReport | null>;
    /** 获取指定会话的快照数据（支持时间过滤和降采样） */
    getSessionSnapshots(sessionId: string, startTime?: number, endTime?: number, maxPoints?: number): Promise<MemorySnapshot[]>;
    /** 对比两个会话 */
    compareSessions(baseId: string, targetId: string): Promise<CompareReport | null>;
    /** 导出会话数据（供 IPC 调用，弹出保存对话框） */
    exportSession(sessionId: string): Promise<{
        success: boolean;
        filePath?: string;
        error?: string;
    }>;
    /** 导入会话数据（供 IPC 调用，弹出打开对话框） */
    importSession(): Promise<{
        success: boolean;
        session?: TestSession;
        error?: string;
    }>;
    /** 删除指定会话 */
    deleteSession(sessionId: string): Promise<boolean>;
    /** 手动触发 GC */
    triggerGC(): Promise<GCResult>;
    /** 导出堆快照 */
    takeHeapSnapshot(filePath?: string): Promise<string>;
    /** 添加事件标记 */
    mark(label: string, metadata?: Record<string, unknown>): void;
    /** 更新渲染进程 V8 详情 */
    updateRendererDetail(detail: RendererV8Detail): void;
    /** 获取当前配置 */
    getConfig(): MonitorConfig;
    on(event: 'snapshot', handler: (data: MemorySnapshot) => void): this;
    on(event: 'anomaly', handler: (event: AnomalyEvent) => void): this;
    on(event: 'session-end', handler: (report: SessionReport) => void): this;
    private onSnapshot;
    private mergeConfig;
}

/**
 * IPC 通道常量定义
 * 所有通道以 'emm:' 为前缀，避免与业务 IPC 冲突
 */
declare const IPC_CHANNELS: {
    readonly SNAPSHOT: "emm:snapshot";
    readonly ANOMALY: "emm:anomaly";
    readonly SESSION_START: "emm:session:start";
    readonly SESSION_STOP: "emm:session:stop";
    readonly SESSION_LIST: "emm:session:list";
    readonly SESSION_REPORT: "emm:session:report";
    readonly SESSION_COMPARE: "emm:session:compare";
    readonly SESSION_SNAPSHOTS: "emm:session:snapshots";
    readonly TRIGGER_GC: "emm:gc";
    readonly HEAP_SNAPSHOT: "emm:heap-snapshot";
    readonly MARK: "emm:mark";
    readonly CONFIG_UPDATE: "emm:config:update";
    readonly GET_CONFIG: "emm:config:get";
    readonly GET_SESSIONS: "emm:sessions:get";
    readonly SESSION_EXPORT: "emm:session:export";
    readonly SESSION_IMPORT: "emm:session:import";
    readonly SESSION_DELETE: "emm:session:delete";
    readonly RENDERER_REPORT: "emm:renderer:report";
    readonly RENDERER_REQUEST: "emm:renderer:request";
};

export { type AnomalyCategory, type AnomalyEvent, type AnomalyRule, type AnomalySeverity, type CompareReport, ElectronMemoryMonitor, type EventMark, type GCResult, IPC_CHANNELS, type Improvement, type MemorySnapshot, type MetricDiff, type MetricSummary, type MonitorConfig, type ProcessMemoryInfo, type Regression, type RendererV8Detail, type SessionIndex, type SessionReport, type Suggestion, type SystemMemoryInfo, type TestSession, type TrendInfo, type V8HeapDetailStats, type V8HeapSpaceInfo, type V8HeapStats };
