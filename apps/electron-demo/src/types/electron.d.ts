export interface AppInfo {
  name: string
  version: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
}

export interface ElectronAPI {
  getAppInfo: () => Promise<AppInfo>
  onMessage: (channel: string, callback: (...args: unknown[]) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
