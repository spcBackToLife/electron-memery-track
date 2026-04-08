# Electron 内存优化专项 —— 运行基准测试与监控方案 v2

## 一、第一性原理：重新定义问题

### 1.1 我们到底要解决什么问题？

从最底层出发，把问题拆到不可再分：

```
终极目标：让 Electron 应用的内存使用处于健康、可控、持续优化的状态
│
├── 前提条件：必须先"看见"
│   ├── Q1: 空的 Electron 应用，什么都不加载，内存基线是多少？
│   ├── Q2: 每个进程（主进程/渲染进程/GPU/辅助进程）各占多少？
│   ├── Q3: 长时间运行，内存是稳定的还是在增长？
│   └── Q4: 加入不同业务场景后，增量各是多少？
│
├── 核心能力：必须能"度量"
│   ├── Q5: 哪个进程、哪段代码、哪种操作导致了内存问题？
│   ├── Q6: 有没有泄漏？泄漏速率是多少？
│   └── Q7: 每次代码迭代，内存是变好了还是变差了？
│
├── 工程化：必须能"持续运行"
│   ├── Q8: 上线前能否自动跑一次，产出报告？
│   ├── Q9: 多次迭代的报告能否对比，发现劣化？
│   └── Q10: 能否给出可操作的改进建议？
│
└── 可复用性：必须能"随处接入"
    ├── Q11: 不同 Electron 项目能否零改动接入？
    ├── Q12: 监控本身的性能开销是否足够低？
    └── Q13: 接入后能否按需开关，不影响生产环境？
```

### 1.2 由此推导出的设计原则

| 原则 | 推导逻辑 | 具体要求 |
|------|---------|---------|
| **SDK 独立** | Q11 → 必须与业务解耦 | 监控作为独立 npm 包，一行代码接入 |
| **零侵入** | Q12/Q13 → 不能修改业务代码 | 所有采集逻辑在主进程完成，不修改渲染进程代码 |
| **可关闭** | Q13 → 生产环境可禁用 | 通过环境变量/配置一键关闭，tree-shaking 友好 |
| **迭代感知** | Q7/Q8/Q9 → 需要多次运行对比 | 每次运行产出标准化报告，支持 diff |
| **场景基线** | Q1-Q4 → 需要控制变量 | monorepo 里的多个 app 模拟不同基线场景 |
| **问题定位** | Q5/Q6 → 需要精细到代码级 | V8 堆详情 + 分离上下文检测 + 堆快照 |
| **可行动** | Q10 → 不只报问题，还要建议怎么改 | 基于模式识别给出改进建议模板 |

---

## 二、Monorepo 整体架构

### 2.1 为什么要 Monorepo？

```
一句话：SDK 和测试场景必须共存、联调、版本同步。

electron-memory-benchmark/
├── packages/
│   └── electron-memory-monitor/     ← SDK：核心采集能力，npm 可发布
│
├── apps/
│   ├── bare-minimum/                ← 场景1：最小化 Electron（空壳）
│   ├── single-window/               ← 场景2：单窗口空白页
│   ├── multi-window/                ← 场景3：多窗口场景
│   ├── heavy-renderer/              ← 场景4：重渲染（大量 DOM / Canvas）
│   ├── ipc-stress/                  ← 场景5：高频 IPC 通信
│   └── real-world-sim/              ← 场景6：模拟真实业务结构
│
└── reports/                         ← 所有测试报告的统一存储
```

### 2.2 完整项目结构

```
electron-memory-benchmark/
│
├── package.json                     # monorepo 根配置
├── pnpm-workspace.yaml              # pnpm workspace 定义
├── tsconfig.base.json               # 共享 TypeScript 基础配置
├── README.md                        # 项目说明
│
├── packages/
│   └── electron-memory-monitor/     # ========== SDK 核心包 ==========
│       ├── package.json             # name: @electron-memory/monitor
│       ├── tsconfig.json
│       ├── tsup.config.ts           # 构建配置（输出 CJS + ESM）
│       │
│       ├── src/
│       │   ├── index.ts             # SDK 入口：export { ElectronMemoryMonitor }
│       │   │
│       │   ├── core/
│       │   │   ├── monitor.ts       # [主入口] ElectronMemoryMonitor 类
│       │   │   ├── collector.ts     # 内存数据采集器
│       │   │   ├── persister.ts     # 数据持久化（JSONL）
│       │   │   ├── session.ts       # 会话管理
│       │   │   ├── anomaly.ts       # 异常检测引擎
│       │   │   └── analyzer.ts      # 报告分析 & 改进建议引擎
│       │   │
│       │   ├── ipc/
│       │   │   ├── channels.ts      # IPC 通道常量定义
│       │   │   ├── main-handler.ts  # 主进程 IPC 注册
│       │   │   └── preload-api.ts   # preload 注入辅助函数
│       │   │
│       │   ├── ui/                  # 监控面板（独立窗口 UI）
│       │   │   ├── index.html       # 监控面板 HTML 入口
│       │   │   ├── monitor-entry.tsx # React 入口
│       │   │   ├── MonitorApp.tsx    # 监控面板根组件
│       │   │   ├── pages/
│       │   │   │   ├── Dashboard.tsx # 实时仪表盘
│       │   │   │   ├── Report.tsx    # 历史报告
│       │   │   │   └── Compare.tsx   # 迭代对比
│       │   │   ├── components/
│       │   │   │   ├── ProcessTable.tsx
│       │   │   │   ├── MemoryChart.tsx
│       │   │   │   ├── MemoryPieChart.tsx
│       │   │   │   ├── AlertPanel.tsx
│       │   │   │   ├── SessionControl.tsx
│       │   │   │   ├── V8HeapDetail.tsx
│       │   │   │   ├── MetricCard.tsx
│       │   │   │   ├── CompareTable.tsx
│       │   │   │   └── SuggestionPanel.tsx
│       │   │   ├── hooks/
│       │   │   │   ├── useMemoryData.ts
│       │   │   │   └── useSession.ts
│       │   │   └── styles/
│       │   │       └── monitor.less
│       │   │
│       │   └── types/
│       │       ├── snapshot.ts      # MemorySnapshot 等数据结构
│       │       ├── session.ts       # TestSession 等
│       │       ├── anomaly.ts       # AnomalyEvent 等
│       │       ├── config.ts        # MonitorConfig 配置类型
│       │       └── report.ts        # 报告 & 对比 类型
│       │
│       └── preload/
│           └── inject.ts            # preload 注入脚本（可选）
│
├── apps/
│   ├── bare-minimum/                # ========== 场景1：最小空壳 ==========
│   │   ├── package.json
│   │   ├── electron/
│   │   │   └── main.ts             # 只有 app + BrowserWindow，不加载任何页面
│   │   └── README.md               # 此场景的说明
│   │
│   ├── single-window/               # ========== 场景2：单窗口空白页 ==========
│   │   ├── package.json
│   │   ├── electron/
│   │   │   ├── main.ts
│   │   │   └── preload.ts
│   │   ├── src/
│   │   │   └── App.tsx             # 空白 React 页面
│   │   ├── index.html
│   │   └── vite.config.ts
│   │
│   ├── multi-window/                # ========== 场景3：多窗口 ==========
│   │   ├── package.json
│   │   ├── electron/
│   │   │   └── main.ts             # 启动时创建 N 个窗口
│   │   ├── src/
│   │   │   └── App.tsx
│   │   └── vite.config.ts
│   │
│   ├── heavy-renderer/              # ========== 场景4：重渲染 ==========
│   │   ├── package.json
│   │   ├── electron/
│   │   │   └── main.ts
│   │   ├── src/
│   │   │   ├── App.tsx             # 大量 DOM 节点 / Canvas / 动画
│   │   │   └── stress/
│   │   │       ├── dom-stress.ts   # DOM 压力测试模块
│   │   │       ├── canvas-stress.ts
│   │   │       └── timer-stress.ts
│   │   └── vite.config.ts
│   │
│   ├── ipc-stress/                  # ========== 场景5：IPC 压力 ==========
│   │   ├── package.json
│   │   ├── electron/
│   │   │   └── main.ts             # 高频 IPC 通信，大数据量传输
│   │   ├── src/
│   │   │   └── App.tsx
│   │   └── vite.config.ts
│   │
│   └── real-world-sim/              # ========== 场景6：真实业务模拟 ==========
│       ├── package.json
│       ├── electron/
│       │   └── main.ts
│       ├── src/
│       │   ├── App.tsx             # 模拟真实场景：路由、列表、弹窗、WebSocket 等
│       │   └── features/
│       │       ├── router-sim.ts
│       │       ├── list-sim.ts
│       │       └── websocket-sim.ts
│       └── vite.config.ts
│
├── reports/                         # ========== 报告统一存储 ==========
│   ├── .gitkeep
│   └── (运行时生成的报告目录)
│
└── scripts/
    ├── run-benchmark.ts             # 批量运行所有场景的基准测试
    ├── compare-reports.ts           # 对比两次测试报告
    └── generate-summary.ts          # 生成汇总报告
```

---

## 三、SDK 设计：`@electron-memory/monitor`

### 3.1 设计目标：极致简单的接入方式

#### 零代码入侵 — 理想接入方式

```typescript
// ===== 业务项目的 electron/main.ts =====
// 只需要加这 3 行，其余代码完全不动

import { ElectronMemoryMonitor } from '@electron-memory/monitor'

const monitor = new ElectronMemoryMonitor({
  enabled: process.env.NODE_ENV !== 'production' // 生产环境自动关闭
})

// ---- 以下是业务项目原有代码，一行不改 ----
import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const win = new BrowserWindow({ /* ... */ })
  win.loadURL('...')
})
```

**这就是全部接入代码。没有更多了。**

#### 为什么能做到零侵入？

```
核心洞察：Electron 的内存信息全部可以从主进程获取，不需要修改渲染进程。

app.getAppMetrics()        → 所有进程的内存概况（不需要渲染进程配合）
process.memoryUsage()      → 主进程 V8 堆（主进程自身 API）
v8.getHeapStatistics()     → 主进程 V8 详情（主进程自身 API）
webContents.getOSProcessId() → PID 与窗口关联（主进程 API）
```

唯一需要渲染进程配合的是"渲染进程的 V8 堆详情"，但这是**增强功能**，不是核心功能。核心监控完全可以只在主进程完成。

### 3.2 SDK API 设计

```typescript
// ===== packages/electron-memory-monitor/src/index.ts =====

export class ElectronMemoryMonitor {

  constructor(config?: Partial<MonitorConfig>)

  // ============ 生命周期 ============

  /**
   * 启动监控。SDK 内部会：
   * 1. 等待 app.whenReady()
   * 2. 注册 IPC handlers
   * 3. 创建监控窗口（可选）
   * 4. 自动开始数据采集
   */
  start(): Promise<void>

  /**
   * 停止监控，释放资源
   */
  stop(): Promise<void>

  /**
   * 销毁实例
   */
  destroy(): Promise<void>

  // ============ 会话控制 ============

  /**
   * 开始一个新的测试会话
   * @param label 会话标签，如 "v1.2.0-空载基准"
   */
  startSession(label: string, description?: string): string  // 返回 sessionId

  /**
   * 结束当前会话，生成报告
   */
  stopSession(): Promise<SessionReport>

  // ============ 监控面板 ============

  /**
   * 打开/关闭监控面板窗口
   */
  openDashboard(): void
  closeDashboard(): void

  // ============ 数据访问 ============

  /**
   * 获取当前最新的内存快照
   */
  getCurrentSnapshot(): MemorySnapshot

  /**
   * 获取历史会话列表
   */
  getSessions(): Promise<TestSession[]>

  /**
   * 获取指定会话的报告
   */
  getSessionReport(sessionId: string): Promise<SessionReport>

  /**
   * 对比两个会话
   */
  compareSessions(baseId: string, targetId: string): Promise<CompareReport>

  // ============ 工具方法 ============

  /**
   * 手动触发 GC
   */
  triggerGC(): Promise<GCResult>

  /**
   * 导出堆快照
   */
  takeHeapSnapshot(filePath?: string): Promise<string>  // 返回文件路径

  // ============ 事件 ============

  on(event: 'snapshot', handler: (data: MemorySnapshot) => void): void
  on(event: 'anomaly', handler: (event: AnomalyEvent) => void): void
  on(event: 'session-end', handler: (report: SessionReport) => void): void
}
```

### 3.3 配置设计

```typescript
interface MonitorConfig {
  // ===== 开关控制 =====
  enabled: boolean                    // 总开关，默认 true
  autoStart: boolean                  // 实例化后是否自动开始采集，默认 true
  openDashboardOnStart: boolean       // 启动后是否自动打开监控面板，默认 true

  // ===== 采集配置 =====
  collectInterval: number             // 采集间隔 (ms)，默认 1000
  persistInterval: number             // 落盘间隔 (条)，默认 60
  enableRendererDetail: boolean       // 是否采集渲染进程 V8 详情（需要 preload 配合），默认 false
  enableV8HeapSpaces: boolean         // 是否采集 V8 堆空间详情，默认 true

  // ===== 异常检测 =====
  anomaly: {
    enabled: boolean                  // 是否启用异常检测，默认 true
    checkInterval: number             // 检测间隔 (ms)，默认 30000
    rules: AnomalyRule[]              // 自定义检测规则
  }

  // ===== 存储配置 =====
  storage: {
    directory: string                 // 数据存储目录，默认 app.getPath('userData') + '/memory-reports'
    maxSessions: number               // 最大保留会话数，默认 50
    maxSessionDuration: number        // 单次会话最大时长 (ms)，默认 24h
  }

  // ===== 监控面板配置 =====
  dashboard: {
    width: number                     // 窗口宽度，默认 1400
    height: number                    // 窗口高度，默认 900
    alwaysOnTop: boolean              // 是否置顶，默认 false
  }

  // ===== 进程标注 =====
  processLabels: {                    // 给窗口进程打标签，方便识别
    [windowTitle: string]: string     // 如 { 'Main Window': '主页面', 'Settings': '设置页' }
  }
}
```

### 3.4 SDK 内部架构

```
ElectronMemoryMonitor（门面类）
│
├── 初始化流程
│   ├── 1. 合并用户配置与默认配置
│   ├── 2. 等待 app.whenReady()
│   ├── 3. 注册 IPC handlers（所有通道自动注册，不需要用户手动调用）
│   ├── 4. 启动 MemoryCollector
│   ├── 5. 启动 AnomalyDetector
│   ├── 6. 初始化 DataPersister
│   └── 7. 创建 Dashboard 窗口（如果 openDashboardOnStart=true）
│
├── MemoryCollector（数据采集）
│   ├── 定时器驱动：setInterval(collectInterval)
│   ├── 数据源：
│   │   ├── app.getAppMetrics()         → 所有进程概览
│   │   ├── process.memoryUsage()       → 主进程 Node.js 内存
│   │   ├── v8.getHeapStatistics()      → 主进程 V8 详情
│   │   ├── v8.getHeapSpaceStatistics() → V8 堆空间
│   │   ├── os.totalmem() / freemem()   → 系统内存
│   │   └── webContents.getOSProcessId()→ PID 映射
│   └── 输出：MemorySnapshot → EventEmitter 广播
│
├── DataPersister（数据持久化）
│   ├── 接收 MemorySnapshot 事件
│   ├── 内存缓冲 → 批量写入 JSONL
│   └── 会话元信息写入 meta.json
│
├── AnomalyDetector（异常检测）
│   ├── 滑动窗口缓冲最近 N 条数据
│   ├── 定时运行检测规则
│   └── 发现异常 → EventEmitter 广播
│
├── Analyzer（报告分析 & 建议引擎）
│   ├── 会话结束时生成统计汇总
│   ├── 两个会话的 diff 对比
│   └── 基于模式匹配生成改进建议
│
├── SessionManager（会话管理）
│   ├── 会话创建/结束
│   ├── 会话索引维护
│   └── 历史会话查询
│
├── DashboardManager（监控面板）
│   ├── 创建/管理独立 BrowserWindow
│   ├── 转发数据到面板渲染进程
│   └── 内置静态资源（HTML/JS/CSS 打包进 SDK）
│
└── IPCBridge（IPC 桥接）
    ├── 自动注册所有 'emm:*' 通道
    ├── 面板 → 主进程的控制指令路由
    └── 主进程 → 面板的数据推送
```

### 3.5 关键设计：监控面板 UI 打包进 SDK

```
问题：SDK 需要自带监控面板 UI，但不能要求业务项目配置 Vite 多入口。
方案：SDK 构建时将 UI 预编译为静态资源，运行时通过 file:// 或内联加载。

构建流程：
1. tsup 编译 SDK 核心逻辑 → dist/index.cjs + dist/index.mjs
2. vite build 编译 UI → dist/ui/ (index.html + assets)
3. SDK 运行时：BrowserWindow.loadFile(path.join(__dirname, 'ui/index.html'))

这样业务项目只需要 npm install，不需要任何构建配置修改。
```

---

## 四、SDK 接入深度的三个层级

### Level 1：零代码入侵（推荐，覆盖 90% 需求）

```typescript
// 业务项目 electron/main.ts —— 只加 3 行
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

new ElectronMemoryMonitor()  // 就这一行，自动完成一切

// ---- 以下业务代码完全不动 ----
```

能力：全进程内存概览 / 主进程 V8 详情 / 异常检测 / 数据持久化 / 监控面板 / 报告

### Level 2：低代码增强（可选，获取渲染进程 V8 详情）

```typescript
// 业务项目 electron/main.ts
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

new ElectronMemoryMonitor({ enableRendererDetail: true })

// 业务项目 electron/preload.ts —— 加 1 行
import { injectRendererReporter } from '@electron-memory/monitor/preload'
injectRendererReporter()  // 自动注入渲染进程内存上报

// ---- 以上就是全部改动 ----
```

新增能力：渲染进程 V8 堆详情（heapUsed, heapTotal, external, arrayBuffers）

### Level 3：深度集成（可选，业务自定义上报）

```typescript
// 业务项目 electron/main.ts
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

const monitor = new ElectronMemoryMonitor()

// 业务代码中在关键操作时手动标记
monitor.mark('user-opened-settings')   // 标记事件，会在趋势图上打点
monitor.mark('large-file-loaded')

// 监听异常，触发自定义逻辑
monitor.on('anomaly', (event) => {
  myLogger.warn('Memory anomaly detected:', event)
})

// CI/CD 中使用：跑完后取报告
const report = await monitor.stopSession()
if (report.regressions.length > 0) {
  process.exit(1)  // 内存劣化，CI 失败
}
```

---

## 五、迭代对比与劣化检测

### 5.1 这是为什么重要？

```
单次报告告诉你"现在多大"，
迭代对比告诉你"是不是变胖了"。

开发闭环：
  代码改动 → 跑基准测试 → 产出报告 → 与上次报告对比 → 发现劣化 → 阻断/告警

这就是 Lighthouse CI 对性能做的事情，我们对内存做同样的事。
```

### 5.2 标准化报告（SessionReport）

```typescript
interface SessionReport {
  // ===== 元信息 =====
  sessionId: string
  label: string                       // 如 "v1.2.0 空载基准"
  description?: string
  startTime: number
  endTime: number
  duration: number                    // ms

  environment: {
    electronVersion: string
    chromeVersion: string
    nodeVersion: string
    platform: string
    arch: string
    totalSystemMemory: number
    cpuModel: string
    cpuCores: number
  }

  // ===== 统计汇总 =====
  summary: {
    // 全局指标
    totalProcesses: { min: number; max: number; avg: number }

    // 总内存（所有进程 workingSetSize 之和）
    totalMemory: MetricSummary        // { initial, final, min, max, avg, p50, p95, p99 }

    // 按进程类型拆分
    byProcessType: {
      browser: MetricSummary          // 主进程
      renderer: MetricSummary[]       // 各渲染进程
      gpu: MetricSummary
      utility: MetricSummary
    }

    // V8 堆内存（主进程）
    mainV8Heap: {
      heapUsed: MetricSummary
      heapTotal: MetricSummary
      external: MetricSummary
      arrayBuffers: MetricSummary
    }

    // 增长趋势（线性回归）
    trends: {
      totalMemory: TrendInfo          // { slope, r2, direction: 'stable' | 'growing' | 'shrinking' }
      browserMemory: TrendInfo
      rendererMemory: TrendInfo
    }
  }

  // ===== 异常事件 =====
  anomalies: AnomalyEvent[]

  // ===== 改进建议 =====
  suggestions: Suggestion[]

  // ===== 快照数据引用（不内联，通过文件路径访问）=====
  dataFile: string                    // snapshots.jsonl 路径
}

interface MetricSummary {
  initial: number                     // 首次采样值
  final: number                       // 最后采样值
  min: number
  max: number
  avg: number
  p50: number                         // 中位数
  p95: number
  p99: number
  delta: number                       // final - initial
  deltaPercent: number                // (final - initial) / initial * 100
}

interface TrendInfo {
  slope: number                       // 线性回归斜率（KB/s 或 bytes/s）
  r2: number                          // 拟合优度（0~1，越大越线性）
  direction: 'stable' | 'growing' | 'shrinking'
  confidence: 'high' | 'medium' | 'low'
}
```

### 5.3 对比报告（CompareReport）

```typescript
interface CompareReport {
  base: { sessionId: string; label: string }     // 基准（旧版本）
  target: { sessionId: string; label: string }   // 目标（新版本）

  // ===== 总体变化 =====
  overall: {
    totalMemory: MetricDiff
    browserMemory: MetricDiff
    rendererMemory: MetricDiff
    gpuMemory: MetricDiff
  }

  // ===== V8 堆变化 =====
  v8Heap: {
    heapUsed: MetricDiff
    heapTotal: MetricDiff
    external: MetricDiff
  }

  // ===== 趋势变化 =====
  trendChanges: {
    metric: string
    baseSlope: number
    targetSlope: number
    change: 'improved' | 'degraded' | 'unchanged'
  }[]

  // ===== 劣化判定 =====
  regressions: Regression[]

  // ===== 改进点 =====
  improvements: Improvement[]

  // ===== 综合结论 =====
  verdict: 'pass' | 'warn' | 'fail'
  verdictReason: string
}

interface MetricDiff {
  base: number                        // 基准值
  target: number                      // 目标值
  delta: number                       // 差值
  deltaPercent: number                // 变化百分比
  status: 'improved' | 'degraded' | 'unchanged'
  severity?: 'minor' | 'major' | 'critical'
}

interface Regression {
  metric: string
  description: string
  baseValue: number
  targetValue: number
  deltaPercent: number
  severity: 'minor' | 'major' | 'critical'
  suggestion: string                  // 改进建议
}
```

### 5.4 劣化判定规则

```typescript
// 默认劣化判定阈值（可配置）
const DEFAULT_REGRESSION_RULES = {
  // 总内存
  totalMemory: {
    warn: 5,    // 增长 >5% → 警告
    fail: 15,   // 增长 >15% → 失败
  },
  // 主进程内存
  browserMemory: {
    warn: 10,
    fail: 25,
  },
  // V8 堆内存
  heapUsed: {
    warn: 10,
    fail: 30,
  },
  // 趋势斜率（新出现持续增长）
  newGrowthTrend: {
    // 基准无增长趋势，但目标出现了 → 自动判定为 warn
    trigger: true,
  }
}
```

---

## 六、改进建议引擎

### 6.1 基于模式识别的自动建议

```typescript
// Analyzer 内置的建议规则集
const SUGGESTION_RULES: SuggestionRule[] = [

  // ===== 规则1：分离上下文（Detached Contexts）=====
  {
    id: 'detached-contexts',
    detect: (report) => {
      const detached = report.v8Details?.numberOfDetachedContexts
      return detached !== undefined && detached > 0
    },
    generate: (report) => ({
      severity: 'critical',
      category: 'memory-leak',
      title: '检测到分离的 V8 上下文（Detached Contexts）',
      description: `发现 ${report.v8Details.numberOfDetachedContexts} 个分离上下文，`
        + '这通常意味着存在未正确销毁的 BrowserWindow 或 WebContents 实例。',
      suggestions: [
        '检查所有 BrowserWindow 是否在关闭时调用了 destroy()',
        '检查是否有闭包持有已关闭窗口的 webContents 引用',
        '使用 Chrome DevTools 的 Memory 面板做堆快照，搜索 "Detached" 关键字',
        '检查 ipcMain.on 监听器是否在窗口关闭后正确移除',
      ],
      relatedCode: [
        'BrowserWindow.on("closed", () => { win = null })',
        'win.destroy()  // 而不仅仅是 win.close()',
      ]
    })
  },

  // ===== 规则2：主进程内存持续增长 =====
  {
    id: 'main-process-leak',
    detect: (report) => {
      return report.summary.trends.browserMemory.direction === 'growing'
        && report.summary.trends.browserMemory.confidence === 'high'
    },
    generate: (report) => ({
      severity: 'warning',
      category: 'memory-leak',
      title: '主进程内存存在持续增长趋势',
      description: `主进程内存以 ${report.summary.trends.browserMemory.slope.toFixed(2)} KB/s 的速率增长，`
        + `R²=${report.summary.trends.browserMemory.r2.toFixed(3)}，高置信度线性增长。`,
      suggestions: [
        '检查主进程中是否有未清理的 setInterval/setTimeout',
        '检查 ipcMain.on 是否存在重复注册（每次窗口创建都注册新监听器）',
        '检查是否有持续增长的 Map/Set/Array 缓存未设置上限',
        '检查 EventEmitter 监听器是否正确移除（注意 removeListener vs removeAllListeners）',
        '运行 --expose-gc 并手动触发 GC，观察内存是否回落（区分泄漏 vs 缓存）',
      ]
    })
  },

  // ===== 规则3：渲染进程内存过高 =====
  {
    id: 'renderer-memory-high',
    detect: (report) => {
      return report.summary.byProcessType.renderer.some(
        r => r.max > 300 * 1024  // 单个渲染进程 > 300MB
      )
    },
    generate: (report) => ({
      severity: 'warning',
      category: 'optimization',
      title: '渲染进程内存占用过高',
      description: '单个渲染进程内存超过 300MB。',
      suggestions: [
        '检查是否加载了过大的图片资源（考虑懒加载/压缩）',
        '检查 DOM 节点数量（超过 1500 个节点会显著增加内存）',
        '检查是否有大量未销毁的 React 组件实例',
        '考虑使用虚拟列表（Virtual List）替代长列表',
        '检查 Canvas/WebGL 资源是否正确释放',
      ]
    })
  },

  // ===== 规则4：old_space 占比过高 =====
  {
    id: 'old-space-dominant',
    detect: (report) => {
      const heapSpaces = report.v8Details?.heapSpaces
      if (!heapSpaces) return false
      const oldSpace = heapSpaces.find(s => s.name === 'old_space')
      const totalUsed = heapSpaces.reduce((sum, s) => sum + s.usedSize, 0)
      return oldSpace ? (oldSpace.usedSize / totalUsed) > 0.85 : false
    },
    generate: () => ({
      severity: 'info',
      category: 'optimization',
      title: 'V8 old_space 占比超过 85%',
      description: '大量对象存活到 old generation，可能存在长生命周期的大对象或缓存未回收。',
      suggestions: [
        '使用堆快照（Heap Snapshot）分析 old_space 中的大对象',
        '检查全局缓存（如 Map/Object）是否设置了过期策略或容量上限',
        '考虑使用 WeakMap/WeakRef 替代强引用缓存',
        '检查闭包是否意外持有大量外部变量',
      ]
    })
  },

  // ===== 规则5：ArrayBuffer 内存偏高 =====
  {
    id: 'arraybuffer-high',
    detect: (report) => {
      const ab = report.summary.mainV8Heap.arrayBuffers.avg
      return ab > 50 * 1024 * 1024  // > 50MB
    },
    generate: () => ({
      severity: 'info',
      category: 'optimization',
      title: 'ArrayBuffer 内存占用偏高',
      description: 'ArrayBuffer/SharedArrayBuffer 平均占用超过 50MB。',
      suggestions: [
        '检查 Buffer.alloc / Buffer.from 的使用，确保用完后不再持有引用',
        '如果使用 IPC 传输大数据，考虑分片传输或使用 MessagePort',
        '检查 Blob/File 对象是否及时释放',
      ]
    })
  },

  // ===== 规则6：GC 效果差 =====
  {
    id: 'gc-ineffective',
    detect: (report) => {
      // 如果有手动 GC 事件，检查 GC 前后内存差异
      // 堆内存使用率长期 > 80%
      const heapUsed = report.summary.mainV8Heap.heapUsed.avg
      const heapTotal = report.summary.mainV8Heap.heapTotal.avg
      return heapTotal > 0 && (heapUsed / heapTotal) > 0.8
    },
    generate: () => ({
      severity: 'warning',
      category: 'memory-leak',
      title: 'V8 堆使用率长期偏高（>80%）',
      description: '堆使用率长期超过 80%，GC 无法有效释放内存，疑似存在内存泄漏。',
      suggestions: [
        '导出堆快照（Heap Snapshot），使用 Chrome DevTools 分析对象留存',
        '对比两个时间点的堆快照，查找"Allocated between snapshots"中的泄漏对象',
        '检查 Event Listeners 是否正确清理',
        '检查 Promise 链是否有未处理的 rejection 导致引用未释放',
      ]
    })
  },

  // ===== 规则7：进程数异常 =====
  {
    id: 'too-many-processes',
    detect: (report) => {
      return report.summary.totalProcesses.max > 10
    },
    generate: (report) => ({
      severity: 'warning',
      category: 'architecture',
      title: `进程数量偏多（最高 ${report.summary.totalProcesses.max} 个）`,
      description: '过多的进程会显著增加内存开销。',
      suggestions: [
        '检查是否创建了不必要的 BrowserWindow',
        '考虑复用窗口而非每次创建新窗口',
        '使用 webContents.setBackgroundThrottling(true) 减少后台进程开销',
        '考虑使用 <webview> 的 partition 属性共享 session 以减少内存',
      ]
    })
  },
]
```

### 6.2 CI/CD 集成模式

```typescript
// scripts/run-benchmark.ts —— 可在 CI 中运行
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

async function runBenchmark() {
  const monitor = new ElectronMemoryMonitor({
    openDashboardOnStart: false,       // CI 中不打开面板
    storage: { directory: './reports' }
  })

  // 跑 5 分钟基准测试
  const sessionId = monitor.startSession(`CI-build-${process.env.BUILD_NUMBER}`)
  await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000))
  const report = await monitor.stopSession()

  // 与上次报告对比
  const sessions = await monitor.getSessions()
  if (sessions.length >= 2) {
    const lastSession = sessions[sessions.length - 2]
    const compare = await monitor.compareSessions(lastSession.id, sessionId)

    if (compare.verdict === 'fail') {
      console.error('❌ 内存劣化检测失败！')
      console.error('劣化项：', compare.regressions)
      process.exit(1)  // CI 失败
    }
  }

  console.log('✅ 内存基准测试通过')
  process.exit(0)
}
```

---

## 七、各测试场景 App 设计

### 7.1 场景矩阵

| App | 目的 | 验证的问题 | 控制变量 |
|-----|------|-----------|---------|
| `bare-minimum` | Electron 裸启动基线 | Q1: 启动一个 Electron app 的最低内存开销是多少？ | 无页面加载，无 preload |
| `single-window` | 单窗口 + 空白页基线 | Q2: 一个空白渲染页面额外增加多少内存？ | 一个空白 HTML |
| `multi-window` | 多窗口基线 | Q3: 每多一个窗口，增量是多少？边际成本？ | 2/5/10/20 个空白窗口 |
| `heavy-renderer` | 渲染压力基线 | Q4: DOM/Canvas/动画对渲染进程内存的影响 | 10k DOM 节点、Canvas 动画、大量定时器 |
| `ipc-stress` | IPC 通信基线 | Q5: 高频 IPC 通信是否导致内存增长？ | 不同频率、不同数据量的 IPC 通信 |
| `real-world-sim` | 模拟真实业务 | Q6: 接近真实应用的综合内存画像 | 路由切换、列表渲染、弹窗、WebSocket |

### 7.2 各 App 的关键配置差异

```typescript
// bare-minimum/electron/main.ts
// 极简：只创建窗口，不加载任何页面
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 })
  win.loadURL('about:blank')  // 甚至可以加载空白页

  new ElectronMemoryMonitor({ autoStart: true })
})

// single-window/electron/main.ts
// 标准：一个窗口 + 空白 React 页面
app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  win.loadFile('dist/index.html')

  new ElectronMemoryMonitor()
})

// multi-window/electron/main.ts
// 可配置：通过环境变量控制窗口数
const WINDOW_COUNT = parseInt(process.env.WINDOW_COUNT || '5')
app.whenReady().then(() => {
  for (let i = 0; i < WINDOW_COUNT; i++) {
    const win = new BrowserWindow({ width: 400, height: 300 })
    win.loadURL('about:blank')
  }

  new ElectronMemoryMonitor({
    processLabels: Object.fromEntries(
      Array.from({ length: WINDOW_COUNT }, (_, i) => [`Window ${i}`, `窗口${i}`])
    )
  })
})

// heavy-renderer/electron/main.ts
// 重渲染：页面内有大量 DOM 操作
// 渲染进程内通过按钮触发不同压力级别

// ipc-stress/electron/main.ts
// IPC 压力：周期性大量 IPC 通信
// 可配置频率(10/100/1000 msg/s)和数据大小(1KB/100KB/1MB)
```

---

## 八、监控面板 UI 设计（升级版）

### 8.1 新增：迭代对比页面

```
┌─────────────────────────────────────────────────────────────────┐
│  📊 迭代对比                                                     │
│                                                                   │
│  基准会话: [v1.1.0 空载基准 ▾]    对比会话: [v1.2.0 空载基准 ▾]  │
│                                                                   │
│  ┌──── 综合判定 ──────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  🟡 WARN — 存在轻微劣化                                    │  │
│  │  总内存增长 +8.2%（180MB → 194.8MB），超过 5% 警告阈值      │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──── 指标对比 ──────────────────────────────────────────────┐  │
│  │ 指标              │ v1.1.0   │ v1.2.0   │ 变化     │ 状态  │  │
│  │ ─────────────────────────────────────────────────────────  │  │
│  │ 总内存(avg)       │ 180 MB   │ 194.8MB  │ +8.2%   │ 🟡   │  │
│  │ 主进程(avg)       │  65 MB   │  68 MB   │ +4.6%   │ ✅   │  │
│  │ 渲染进程(avg)     │  95 MB   │ 106 MB   │ +11.6%  │ 🟡   │  │
│  │ V8 Heap Used(avg) │  25 MB   │  28 MB   │ +12.0%  │ 🟡   │  │
│  │ V8 External(avg)  │   5 MB   │   5 MB   │ +0.2%   │ ✅   │  │
│  │ GPU 进程(avg)     │  45 MB   │  44 MB   │ -2.2%   │ ✅   │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──── 趋势对比图 ────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  [两次测试的内存趋势叠加在同一张图上，方便直观对比]          │  │
│  │   ── v1.1.0（蓝色实线）                                    │  │
│  │   ── v1.2.0（橙色实线）                                    │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌──── 改进建议 ──────────────────────────────────────────────┐  │
│  │                                                             │  │
│  │  ⚠️ 渲染进程内存增长 +11.6%                                │  │
│  │    可能原因：                                               │  │
│  │    • 新增的 DOM 节点未在组件卸载时清理                       │  │
│  │    • 新引入的第三方库占用了额外内存                          │  │
│  │    建议操作：                                               │  │
│  │    1. 对比两个版本的 package.json 依赖变化                   │  │
│  │    2. 在渲染进程做堆快照 diff，定位新增的大对象              │  │
│  │    3. 检查新增组件的 useEffect 清理函数                      │  │
│  │                                                             │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 8.2 实时仪表盘（保持上版设计，增加事件标记）

在趋势图上支持 `monitor.mark()` 打点，显示用户自定义事件标记，方便关联"在这一刻执行了什么操作"与"内存发生了什么变化"。

---

## 九、技术选型（定稿）

| 维度 | 选择 | 理由 |
|------|------|------|
| **Monorepo 工具** | **pnpm workspace** | 快、磁盘效率高、原生 workspace 支持 |
| **SDK 构建** | **tsup** | 基于 esbuild，构建快，原生支持 CJS+ESM 双格式输出 |
| **UI 构建** | **Vite** | 项目已有 Vite，保持一致；UI 预构建后打包进 SDK |
| **图表库** | **Recharts** | React 生态、轻量、API 简洁 |
| **数据存储** | **JSONL 文件** | 无外部依赖、追加写入、流式读取 |
| **样式** | **Less** | 项目已有 Less 配置，保持一致 |
| **测试场景构建** | **Vite + vite-plugin-electron** | 每个 app 独立 Vite 配置 |
| **统计分析** | **内置** | 线性回归/百分位数等算法很简单，不值得引入额外库 |

---

## 十、IPC 通信协议设计（精简版）

所有通道以 `emm:` (Electron Memory Monitor) 为前缀，避免冲突。

```typescript
// === 数据推送（主进程 → 监控面板）===
'emm:snapshot'              // 推送内存快照
'emm:anomaly'               // 推送异常事件

// === 会话控制（面板 → 主进程）===
'emm:session:start'         // 开始会话 → { label, description }
'emm:session:stop'          // 停止会话 → void
'emm:session:list'          // 获取会话列表 → TestSession[]
'emm:session:report'        // 获取报告 → SessionReport
'emm:session:compare'       // 对比两个会话 → CompareReport

// === 工具操作（面板 → 主进程）===
'emm:gc'                    // 触发 GC
'emm:heap-snapshot'         // 导出堆快照
'emm:mark'                  // 添加事件标记
'emm:config:update'         // 更新采集配置

// === 渲染进程上报（可选，Level 2 接入才需要）===
'emm:renderer:report'       // 渲染进程上报自身 V8 内存
'emm:renderer:request'      // 主进程请求渲染进程上报
```

---

## 十一、Electron 内存模型详解

### 11.1 进程架构与可采集指标完整映射

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Electron App                                    │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Main Process (Browser)                                             │  │
│  │ PID: via process.pid                                               │  │
│  │                                                                    │  │
│  │  采集源 ①: app.getAppMetrics()                                    │  │
│  │    → workingSetSize / peakWorkingSetSize / privateBytes            │  │
│  │    → cpu.percentCPUUsage                                          │  │
│  │                                                                    │  │
│  │  采集源 ②: process.memoryUsage()                                  │  │
│  │    → rss / heapTotal / heapUsed / external / arrayBuffers         │  │
│  │                                                                    │  │
│  │  采集源 ③: v8.getHeapStatistics()                                 │  │
│  │    → totalHeapSize / usedHeapSize / heapSizeLimit                 │  │
│  │    → mallocedMemory / peakMallocedMemory                          │  │
│  │    → numberOfDetachedContexts ← 💡 泄漏关键信号                   │  │
│  │                                                                    │  │
│  │  采集源 ④: v8.getHeapSpaceStatistics()                            │  │
│  │    → [new_space, old_space, code_space, ...] 各空间详情            │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │ Renderer Process  │  │ GPU Process      │  │ Utility Process(es) │  │
│  │                   │  │                  │  │                     │  │
│  │ 采集源 ①: 同上    │  │ 采集源 ①: 同上  │  │ 采集源 ①: 同上      │  │
│  │ (getAppMetrics)   │  │ (getAppMetrics)  │  │ (getAppMetrics)     │  │
│  │                   │  │                  │  │                     │  │
│  │ 采集源 ⑤ (可选):  │  │ (无 V8 堆数据)  │  │ (无 V8 堆数据)     │  │
│  │ 渲染进程内        │  │                  │  │                     │  │
│  │ process.memoryUsage│  │                  │  │                     │  │
│  │ (需 preload 配合) │  │                  │  │                     │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │
│                                                                          │
│  🔗 PID 关联：webContents.getOSProcessId() → 将 PID 映射到窗口         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 十二、开发计划

### Phase 0：Monorepo 基础设施 ⏱️ 0.5 天
- [ ] 初始化 pnpm workspace + monorepo 结构
- [ ] 配置共享 tsconfig.base.json
- [ ] 配置 SDK 包 `@electron-memory/monitor` 的 package.json
- [ ] 配置 tsup 构建
- [ ] 迁移现有 demo 代码到 `apps/single-window`

### Phase 1：SDK 核心采集 ⏱️ 2 天
- [ ] 实现 `ElectronMemoryMonitor` 主类（门面模式）
- [ ] 实现 `MemoryCollector`（基于 `app.getAppMetrics` + `process.memoryUsage` + `v8` 模块）
- [ ] 实现 `DataPersister`（JSONL 写入 + WriteStream）
- [ ] 实现 `SessionManager`（会话生命周期 + 索引维护）
- [ ] 定义 IPC 通道 + 注册
- [ ] 实现 preload 可选注入
- [ ] 验证：在 `apps/single-window` 中一行代码接入

### Phase 2：监控面板 ⏱️ 3 天
- [ ] 实现 DashboardManager（独立 BrowserWindow 管理）
- [ ] 实现实时仪表盘（MetricCard + ProcessTable + MemoryChart + PieChart）
- [ ] 实现会话控制面板（开始/停止/标签/GC）
- [ ] UI 预构建打包进 SDK dist
- [ ] 实现事件标记（mark）在趋势图上的显示

### Phase 3：异常检测 & 报告 ⏱️ 2 天
- [ ] 实现 `AnomalyDetector`（4 种检测策略）
- [ ] 实现 `Analyzer`（统计汇总 + 趋势分析 + 线性回归）
- [ ] 实现 `SessionReport` 生成
- [ ] 实现改进建议引擎（7 条内置规则）
- [ ] 实现历史报告页面

### Phase 4：迭代对比 ⏱️ 1.5 天
- [ ] 实现 `CompareReport` 生成
- [ ] 实现迭代对比页面 UI
- [ ] 实现劣化判定规则
- [ ] 实现趋势叠加对比图

### Phase 5：测试场景 Apps ⏱️ 2 天
- [ ] 实现 `bare-minimum` 场景
- [ ] 实现 `single-window` 场景（迁移现有 demo）
- [ ] 实现 `multi-window` 场景
- [ ] 实现 `heavy-renderer` 场景
- [ ] 实现 `ipc-stress` 场景
- [ ] 实现 `real-world-sim` 场景
- [ ] 编写 `scripts/run-benchmark.ts` 批量运行脚本

### Phase 6：CI/CD 集成 & 完善 ⏱️ 1 天
- [ ] 实现 headless 模式（无 UI，适合 CI）
- [ ] 实现报告 JSON 导出 / CSV 导出
- [ ] 实现堆快照导出
- [ ] 编写 README 和接入文档
- [ ] 监控面板自身进程标记 & 排除

**总计约 12 天**

---

## 十三、关键注意事项

### 13.1 海森堡效应的控制

| 问题 | 解决方案 |
|------|---------|
| 监控面板本身是一个渲染进程 | 在 ProcessTable 中标记为 `[Monitor]`，报告中单独列出 |
| 数据采集本身消耗 CPU | 采集间隔默认 1s，可调大；采集操作本身都是同步 API，<1ms |
| JSONL 写入消耗 IO | 内存缓冲 60 条后批量写入，WriteStream 异步 |
| SDK 代码占用主进程内存 | SDK 代码极小（<100KB），相比 Electron 基线 (>100MB) 可忽略 |

### 13.2 SDK 的 Tree-shaking 友好

```typescript
// 支持条件导入，生产环境完全不加载
if (process.env.NODE_ENV !== 'production') {
  const { ElectronMemoryMonitor } = await import('@electron-memory/monitor')
  new ElectronMemoryMonitor()
}
```

### 13.3 数据安全

- 所有数据存储在本地文件系统（`app.getPath('userData')`）
- 不上传任何数据到外部服务器
- 报告中不包含源代码内容
- 堆快照可能包含敏感数据，需提醒用户谨慎分享

---

## 十四、预期产出

完成全部 Phase 后，将获得：

### 工具产出
1. **`@electron-memory/monitor`** — 独立 npm SDK，一行代码接入任何 Electron 项目
2. **实时监控面板** — 进程级内存实时可视化
3. **报告系统** — 自动生成标准化内存报告，支持迭代对比
4. **改进建议引擎** — 基于模式识别自动给出优化建议
5. **CI/CD 集成能力** — 上线前自动检测内存劣化

### 数据产出
1. **Electron 空载基线** — 各进程类型的最低内存开销
2. **场景基线矩阵** — 不同场景（多窗口/重渲染/IPC压力）的内存画像
3. **劣化阈值体系** — 明确的 warn/fail 阈值，可在 CI 中使用

### 方法论产出
1. **测量 → 诊断 → 建议 → 验证** 的完整闭环
2. 可复用到任何 Electron 项目的标准化内存优化流程
3. 迭代间的内存质量守护机制
