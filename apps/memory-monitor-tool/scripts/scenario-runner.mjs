#!/usr/bin/env node
/**
 * 执行 JSON 场景：连接被测 Electron (CDP) + 调用监控工具 API 打 mark。
 *
 * 用法：
 *   pnpm scenario
 *   pnpm scenario scripts/scenarios/my.scenario.json
 *
 * 环境变量：
 *   CDP_URL          默认 http://127.0.0.1:9222
 *   MMT_API_URL      默认 http://127.0.0.1:39271
 *   PWDEBUG=1        Playwright 调试暂停
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import playwright from 'playwright'
import { connectBrowser, pickMainPage } from './automation/cdp-page.mjs'
import { resolveLocator } from './automation/locator.mjs'
import { mmtHealth, mmtMark, waitForMmtSession } from './automation/mmt-client.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loadScenario(argPath) {
  const scenarioPath = argPath
    ? path.resolve(process.cwd(), argPath)
    : path.join(__dirname, 'scenarios', 'example.scenario.json')
  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`场景文件不存在: ${scenarioPath}`)
  }
  const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'))
  if (!raw || typeof raw !== 'object') throw new Error('场景 JSON 无效')
  return { scenarioPath, scenario: raw }
}

function applyScenarioEnv(scenario) {
  if (scenario.cdpUrl) process.env.CDP_URL = scenario.cdpUrl
  if (scenario.mmtApiUrl) process.env.MMT_API_URL = scenario.mmtApiUrl
}

async function runStep(step, ctx) {
  const type = step.type
  if (!type) throw new Error('步骤缺少 type')

  switch (type) {
    case 'wait': {
      const ms = Number(step.ms ?? step.durationMs)
      if (!Number.isFinite(ms) || ms < 0) throw new Error('wait 需要 ms >= 0')
      if (step.note) ctx.log('[wait]', step.note, `(${ms}ms)`)
      await sleep(ms)
      return
    }
    case 'mark': {
      const label = String(step.label ?? '').trim()
      if (!label) throw new Error('mark 需要 label')
      await ctx.mark(label, step.metadata)
      return
    }
    case 'click': {
      const timeout = Number(step.timeout ?? 30_000)
      const loc = resolveLocator(ctx.page, step.locator)
      if (step.note) ctx.log('[click]', step.note)
      await loc.click({ timeout })
      const shouldMark =
        step.markAfterClick === true ||
        (step.markAfterClick !== false && ctx.autoMarkClicks)
      if (shouldMark) {
        const label =
          (typeof step.markLabel === 'string' && step.markLabel.trim()) ||
          (typeof step.note === 'string' && step.note.trim()) ||
          `click-${ctx.clickIndex ?? 0}`
        await ctx.mark(label, { step: 'click', stepIndex: ctx.clickIndex })
      }
      if (ctx.clickIndex != null) ctx.clickIndex += 1
      return
    }
    case 'fill': {
      const timeout = Number(step.timeout ?? 30_000)
      const loc = resolveLocator(ctx.page, step.locator)
      await loc.fill(String(step.value ?? ''), { timeout })
      return
    }
    case 'press': {
      const key = String(step.key ?? 'Enter')
      await ctx.page.keyboard.press(key)
      return
    }
    case 'module': {
      const rel = String(step.path ?? step.file ?? '').trim()
      if (!rel) throw new Error('module 需要 path')
      const modPath = path.isAbsolute(rel) ? rel : path.resolve(path.dirname(ctx.scenarioPath), rel)
      const mod = await import(pathToFileURL(modPath).href)
      const fn = mod.run ?? mod.default
      if (typeof fn !== 'function') throw new Error(`${modPath} 需 export async function run(page, ctx)`)
      await fn(ctx.page, ctx)
      return
    }
    default:
      throw new Error(`未知步骤 type: ${type}`)
  }
}

async function main() {
  const argPath = process.argv[2]
  const { scenarioPath, scenario } = loadScenario(argPath)
  applyScenarioEnv(scenario)

  console.log('=== 内存场景 runner ===')
  console.log('场景:', scenario.name ?? path.basename(scenarioPath))
  console.log('文件:', scenarioPath)
  if (scenario.description) console.log('说明:', scenario.description)

  try {
    await mmtHealth()
    console.log('[mmt] API 可达:', process.env.MMT_API_URL ?? 'http://127.0.0.1:39271')
  } catch (e) {
    console.warn('[mmt] 警告: 监控工具 API 不可达，mark 将失败。请先 pnpm dev 启动监控工具。')
    console.warn(String(e))
  }

  const skipMmt = process.env.SKIP_MMT_SESSION === '1' || scenario.requireMmtSession === false
  if (!skipMmt) {
    console.log('[mmt] 等待运行中的监控会话…')
    console.log('[mmt] 若尚未附加：请切到监控工具 → 选中游戏进程 →「附加并监控」（脚本最多等 5 分钟）')
    const st = await waitForMmtSession(Number(process.env.MMT_SESSION_WAIT_MS ?? 300_000))
    console.log('\n[mmt] 会话已就绪:', st.sessionLabel ?? st.sessionId)
  } else {
    console.log('[mmt] 已跳过会话等待（SKIP_MMT_SESSION 或 requireMmtSession:false）')
  }

  const browser = await connectBrowser(playwright)
  const page = await pickMainPage(browser, {
    pageUrlIncludes: scenario.pageUrlIncludes || undefined,
  })

  const ctx = {
    page,
    browser,
    scenarioPath,
    autoMarkClicks: scenario.autoMarkClicks === true,
    clickIndex: 1,
    log: (...args) => console.log(...args),
    mark: async (label, metadata) => {
      try {
        await mmtMark(label, metadata)
        console.log('[mark]', label)
      } catch (e) {
        console.warn('[mark] 失败（继续执行）:', label, String(e))
      }
    },
  }

  if (scenario.warmupMs != null && Number(scenario.warmupMs) > 0) {
    const warmup = Number(scenario.warmupMs)
    await ctx.mark('warmup-start')
    console.log('[warmup]', warmup, 'ms')
    await sleep(warmup)
    await ctx.mark('baseline')
  }

  const steps = Array.isArray(scenario.steps) ? scenario.steps : []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log(`\n--- step ${i + 1}/${steps.length}: ${step.type} ---`)
    await runStep(step, ctx)
  }

  console.log('\n=== 场景完成 ===')
  console.log('请勿 browser.close()；被测应用保持运行，请在监控工具中结束会话。')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
