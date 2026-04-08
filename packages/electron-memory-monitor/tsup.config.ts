import { defineConfig } from 'tsup'

export default defineConfig([
  // 主入口 - SDK 核心（主进程使用）
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    external: ['electron'],
    platform: 'node',
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
  },
  // preload 入口（可选注入，业务项目 preload 使用）
  {
    entry: {
      preload: 'src/preload/inject.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    external: ['electron'],
    platform: 'node',
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
  },
  // 监控面板 preload（SDK 内部使用，Dashboard BrowserWindow 专用）
  {
    entry: {
      'dashboard-preload': 'src/core/dashboard-preload.ts',
    },
    format: ['cjs'],
    external: ['electron'],
    platform: 'node',
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
  },
])
