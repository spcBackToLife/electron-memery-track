/**
 * 对齐 launcher multi-window 中标签页 webview-common-sdk preload 的角色。
 * 用户问题复现时可在本文件通过 contextBridge 暴露与内置浏览器一致的 API。
 */
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('__browserSimTabPreload', {
  version: 'browser-sim-test-tab-preload',
})
