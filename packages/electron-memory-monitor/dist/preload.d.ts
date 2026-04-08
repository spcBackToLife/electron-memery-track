/**
 * 渲染进程 V8 内存上报注入
 *
 * 这是可选的 Level 2 接入：在业务项目的 preload.ts 中调用
 * 用于采集渲染进程自身的 V8 堆详情
 */
/**
 * 注入渲染进程内存上报器
 * 在业务项目的 preload.ts 中调用：
 *
 * ```ts
 * import { injectRendererReporter } from '@electron-memory/monitor/preload'
 * injectRendererReporter()
 * ```
 */
declare function injectRendererReporter(interval?: number): () => void;

export { injectRendererReporter };
