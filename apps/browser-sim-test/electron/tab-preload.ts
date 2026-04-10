/**
 * 对齐 launcher multi-window 中标签页 webview-common-sdk preload 的角色。
 * 用户问题复现时可在本文件通过 contextBridge 暴露与内置浏览器一致的 API。
 */
import { contextBridge } from 'electron'
import { injectRendererReporter } from '@electron-memory/monitor/preload'

contextBridge.exposeInMainWorld('__browserSimTabPreload', {
  version: 'browser-sim-test-tab-preload',
})

// 向监控 SDK 定时上报本渲染进程 V8 用量（Level 2）
injectRendererReporter(2000)
