/**
 * 标签页 WebContents 专用 preload：向监控 SDK 定时上报本渲染进程 V8 用量（Level 2）
 */
import { injectRendererReporter } from '@electron-memory/monitor/preload'

injectRendererReporter(2000)
