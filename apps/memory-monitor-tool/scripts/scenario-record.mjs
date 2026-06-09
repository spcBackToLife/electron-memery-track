#!/usr/bin/env node
/**
 * 对已运行的 Electron（CDP 9222）打开 Playwright Inspector 录制。
 * codegen CLI 不支持 --cdp-endpoint，官方推荐 connectOverCDP + page.pause()。
 *
 * 用法：
 *   pnpm scenario:codegen
 *   CDP_URL=http://127.0.0.1:9222 pnpm scenario:codegen
 *
 * 录制完成后把 Inspector 里的代码拷到 scripts/scenarios/recorded.js
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from 'playwright'
import { connectBrowser, listPages, pickMainPage } from './automation/cdp-page.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outHint = path.join(__dirname, 'scenarios', 'recorded.js')

async function main() {
  console.log('=== Playwright 录制（CDP）===')
  console.log('1. 被测应用需已启动，例如：your-app.exe --remote-debugging-port=9222')
  console.log('2. 若连接失败，可再加：--remote-allow-origins=*')
  console.log('3. Inspector 打开后，在被测窗口操作；代码会出现在 Inspector 中')
  console.log(`4. 录完请保存到：${outHint}`)
  console.log('   或在 *.scenario.json 中：{ "type": "module", "path": "./recorded.js" }')
  console.log('')

  const browser = await connectBrowser(playwright)
  const pages = await listPages(browser)
  if (pages.length === 0) {
    throw new Error('CDP 下没有页面。请确认被测应用已启动且 9222 可访问。')
  }

  const page = await pickMainPage(browser)
  console.log('\n即将打开 Playwright Inspector（page.pause）…')
  console.log('关闭 Inspector 后本脚本结束；请勿关闭被测应用。\n')

  await page.pause()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
