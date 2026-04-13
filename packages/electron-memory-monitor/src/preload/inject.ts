/**
 * 渲染进程 V8 内存上报注入
 * 
 * 这是可选的 Level 2 接入：在业务项目的 preload.ts 中调用
 * 用于采集渲染进程自身的 V8 堆详情
 */

import { ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../ipc/channels'

/**
 * 注入渲染进程内存上报器
 * 在业务项目的 preload.ts 中调用：
 * 
 * ```ts
 * import { injectRendererReporter } from '@electron-memory/monitor/preload'
 * injectRendererReporter()
 * ```
 */
export function injectRendererReporter(interval = 2000): () => void {
  if (typeof process === 'undefined' || typeof process.memoryUsage !== 'function') {
    console.warn(
      '[@electron-memory/monitor] injectRendererReporter 需要 Node 的 process.memoryUsage。' +
        'Electron 在 webPreferences.sandbox=true（或默认沙箱）的 preload 里不提供 process，上报不会生效。' +
        '请将业务 WebContents 设为 sandbox: false，或为该窗口关闭沙箱。'
    )
    return () => {}
  }

  let timer: ReturnType<typeof setInterval> | null = null

  const report = () => {
    try {
      const mem = process.memoryUsage()
      ipcRenderer.send(IPC_CHANNELS.RENDERER_REPORT, {
        webContentsId: -1, // 由主进程根据 sender 重写
        pid: process.pid,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      })
    } catch (err) {
      console.warn('[@electron-memory/monitor] injectRendererReporter 上报失败:', err)
    }
  }

  // 监听主进程请求上报
  ipcRenderer.on(IPC_CHANNELS.RENDERER_REQUEST, () => {
    report()
  })

  // 定时上报
  timer = setInterval(report, interval)

  // 返回清理函数
  return () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    ipcRenderer.removeAllListeners(IPC_CHANNELS.RENDERER_REQUEST)
  }
}
