/**
 * Vite 配置 - 监控面板 UI 构建
 * 
 * 将 React 监控面板编译为静态 HTML/JS/CSS 资源
 * 打包进 SDK 的 dist/ui/ 目录
 * 运行时通过 BrowserWindow.loadFile() 加载
 */

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],

  // 使用相对路径，因为面板通过 file:// 协议加载
  base: './',

  root: path.resolve(__dirname, 'src/ui'),

  build: {
    outDir: path.resolve(__dirname, 'dist/ui'),
    emptyOutDir: true,
    // 面板资源较小，内联阈值可以大一些减少文件数
    assetsInlineLimit: 8192,
    // 提高 chunk 大小警告阈值（监控面板不需要极致优化）
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/ui/index.html'),
      output: {
        manualChunks: {
          'vendor': ['react', 'react-dom', 'recharts'],
        },
      },
    },
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  css: {
    preprocessorOptions: {
      less: {},
    },
  },
})
