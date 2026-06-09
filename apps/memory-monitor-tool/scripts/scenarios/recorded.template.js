/**
 * Playwright codegen 录制产物模板。
 *
 * 1. 被测应用：your-app.exe --remote-debugging-port=9222
 * 2. 录制：pnpm scenario:codegen（connectOverCDP + Inspector，非 codegen CLI）
 * 3. 把生成的点击代码拷到 run() 里
 * 4. 在 *.scenario.json 里加：{ "type": "module", "path": "./recorded.js" }
 */

/** @param {import('playwright').Page} page */
/** @param {{ mark: (label: string, meta?: object) => Promise<void>, log: (...args: unknown[]) => void }} ctx */
export async function run(page, ctx) {
  ctx.log('recorded.run start')

  // === 把 codegen 生成的代码贴在这里，例如： ===
  // await page.getByRole('button', { name: '开始' }).click()
  // await page.locator('[data-testid="open-video"]').click()

  await ctx.mark('recorded-done')
}
