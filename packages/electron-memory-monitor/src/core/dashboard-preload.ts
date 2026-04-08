/**
 * Dashboard Preload 脚本
 * 在监控面板 BrowserWindow 中使用
 */

import { injectMonitorPanelAPI } from '../ipc/preload-api'

injectMonitorPanelAPI()
