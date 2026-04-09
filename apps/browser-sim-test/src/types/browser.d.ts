interface Tab {
  id: string
  title: string
  url: string
}

interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
}

interface AutoTestProgress {
  round: number
  totalRounds: number
  phase: string
}

interface LaunchEnvInfo {
  disableHardwareAcceleration: boolean
  disableGpuSandboxSwitch: boolean
  argv: string[]
}

interface MemoryInfo {
  tabCount: number
  processCount: number
  totalMemory: number
  mainProcessMemory: {
    rss: number
    heapTotal: number
    heapUsed: number
    external: number
    arrayBuffers: number
  }
  metrics: Array<{
    pid: number
    type: string
    memory: { workingSetSize: number; peakWorkingSetSize: number }
    cpu: { percentCPUUsage: number }
  }>
}

interface BrowserAPI {
  openTab: (url: string) => Promise<{ tabId: string; title: string; url: string } | null>
  closeTab: (tabId: string) => Promise<boolean>
  closeAllTabs: () => Promise<boolean>
  switchTab: (tabId: string) => Promise<boolean>
  getTabs: () => Promise<TabsState>
  batchOpen: (urls: string[], delayMs: number) => Promise<Array<{ tabId: string; title: string; url: string }>>
  autoTestStart: (options: {
    urls: string[]
    openDelay: number
    closeDelay: number
    rounds: number
  }) => Promise<{ success?: boolean; error?: string }>
  autoTestStop: () => Promise<boolean>
  getMemoryInfo: () => Promise<MemoryInfo>
  getLaunchEnv: () => Promise<LaunchEnvInfo>
  onTabsChanged: (callback: (payload: TabsState) => void) => void
  onAutoTestProgress: (callback: (progress: AutoTestProgress) => void) => void
  onAutoTestDone: (callback: () => void) => void
  onProcessDiagnostic: (
    callback: (payload: Record<string, unknown> & { line?: string }) => void
  ) => void
}

declare global {
  interface Window {
    browserAPI: BrowserAPI
  }
}

export type {
  Tab,
  TabsState,
  AutoTestProgress,
  MemoryInfo,
  LaunchEnvInfo,
  BrowserAPI,
}
