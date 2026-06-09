#!/usr/bin/env node
/**
 * 检查 CDP 9222 是否真的在监听，以及是哪个进程占用的。
 *
 *   pnpm scenario:check-cdp
 *   CDP_URL=http://127.0.0.1:9333 pnpm scenario:check-cdp
 */

import { execSync } from 'node:child_process'
import { probeCdpEndpoint, getCdpUrl } from './automation/cdp-page.mjs'

const cdpUrl = getCdpUrl()
const port = (() => {
  try {
    return new URL(cdpUrl).port || '9222'
  } catch {
    return '9222'
  }
})()

console.log('=== CDP 诊断 ===')
console.log('CDP_URL:', cdpUrl)
console.log('')

const probe = await probeCdpEndpoint(cdpUrl)
if (probe.ok) {
  console.log('✅ CDP 可达')
  console.log('   Browser:', probe.browser ?? '(unknown)')
  console.log('   页面数:', probe.pageCount ?? 0)
  if (probe.pages?.length) {
    console.log('   页面列表:')
    for (const p of probe.pages) {
      console.log(`     - ${p.title || '(no title)'} | ${p.url}`)
    }
  }
  console.log('\n可以跑: pnpm scenario:launcher')
} else {
  console.log('❌ CDP 不可达:', probe.error)
  console.log('')
  console.log('常见原因：')
  console.log('  1. 启动参数加在「启动器」上，真正带界面的子进程没带上端口')
  console.log('  2. 附加监控的进程 (如 DB_xxx.exe) 不是开 CDP 的那个 Electron 主进程')
  console.log('  3. 需要同时加: --remote-debugging-port=9222 --remote-allow-origins=*')
  console.log('  4. 端口被占用，应用静默换到了别的端口')
  console.log('')
  console.log('请手动验证：浏览器打开', `${cdpUrl.replace(/\/$/, '')}/json`)
  console.log('  能打开 JSON 列表 → CDP 正常；打不开 → 端口没在监听')
}

if (process.platform === 'win32') {
  console.log('\n--- 本机谁占用了端口', port, '---')
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' }).trim()
    if (!out) {
      console.log('(无进程监听', port, '— 与 ECONNREFUSED 一致)')
    } else {
      console.log(out)
      console.log('最后一列是 PID；对比监控工具里附加的 PID 是否一致')
    }
  } catch {
    console.log('(无法执行 netstat)')
  }
}

process.exit(probe.ok ? 0 : 1)
