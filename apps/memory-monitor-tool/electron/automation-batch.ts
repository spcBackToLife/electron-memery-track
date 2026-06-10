/**
 * 批量自动化：启动应用 → 监控会话 → 跑场景 → 结束会话 → 杀进程 → 重复
 */

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

export interface AutomationBatchOptions {
  appPath: string
  scenarioPath: string
  /** 会话名前缀，最终形如 `{prefix}-{appName}-run{N}-{时间}`，默认 auto */
  sessionPrefix?: string
  repeats?: number
  cdpPort?: number
  stepDelayMs?: number
  warmupBeforeScenarioMs?: number
  cooldownAfterScenarioMs?: number
  betweenRunsMs?: number
  extraArgs?: string[]
}

export interface AutomationBatchProgress {
  phase: string
  runIndex: number
  totalRuns: number
  message: string
}

export interface AutomationBatchDeps {
  launchApp: (
    appPath: string,
    args: string[],
    sessionLabel?: string,
    onLaunchStatus?: (message: string) => void,
  ) => Promise<{ success: boolean; error?: string; session?: { id: string; label: string } }>
  endSession: () => Promise<unknown>
  killTarget: () => Promise<void>
  resetRuntime: () => void
  isSessionRunning: () => boolean
  ensureMonitorActive?: (cdpPort: number, sessionLabel: string) => Promise<void>
  onProgress: (p: AutomationBatchProgress) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function probeCdp(port: number, timeoutMs: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* retry */ }
    await sleep(1000)
  }
  return false
}

function buildScenarioRunnerEnv(cdpPort: number): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_') || key.startsWith('ELECTRON_RENDERER_') || key === 'ELECTRON_RUN_AS_NODE') {
      delete env[key]
    }
  }
  env.CDP_URL = `http://127.0.0.1:${cdpPort}`
  env.MMT_SESSION_WAIT_MS = '30000'
  return env
}

function runScenarioScript(scenarioPath: string, appRoot: string, cdpPort: number): Promise<void> {
  const timeoutMs = Math.max(60_000, Number(process.env.SCENARIO_RUN_TIMEOUT_MS ?? 1_800_000))
  return new Promise((resolve, reject) => {
    const runner = path.join(appRoot, 'scripts', 'scenario-runner.mjs')
    const child = spawn(process.execPath, [runner, scenarioPath], {
      cwd: appRoot,
      env: buildScenarioRunnerEnv(cdpPort),
      stdio: 'inherit',
      shell: false,
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch { /* ignore */ }
      reject(new Error(`scenario-runner 超时（${timeoutMs}ms），已强制结束`))
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`scenario-runner exit ${code ?? '?'}`))
    })
  })
}

function buildSessionLabel(prefix: string | undefined, appName: string, runIndex: number): string {
  const safePrefix = (prefix?.trim() || 'auto').replace(/\s+/g, '-')
  const time = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `${safePrefix}-${appName}-run${runIndex}-${time}`
}

function buildCdpArgs(port: number, extra: string[] = []): string[] {
  const base = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*']
  const out = [...base]
  for (const a of extra) {
    if (!out.some((x) => x === a || x.startsWith('--remote-debugging-port='))) {
      if (a.startsWith('--remote-debugging-port=')) continue
      out.push(a)
    }
  }
  return out
}

export async function runAutomationBatch(
  opts: AutomationBatchOptions,
  deps: AutomationBatchDeps,
): Promise<{ completed: number; errors: string[] }> {
  const repeats = Math.max(1, opts.repeats ?? 1)
  const cdpPort = opts.cdpPort ?? 9222
  const warmup = Math.max(0, opts.warmupBeforeScenarioMs ?? 15_000)
  const cooldown = Math.max(0, opts.cooldownAfterScenarioMs ?? 5_000)
  const between = Math.max(0, opts.betweenRunsMs ?? 8_000)
  const appRoot = path.join(__dirname, '..')
  const scenarioPath = path.isAbsolute(opts.scenarioPath)
    ? opts.scenarioPath
    : path.resolve(appRoot, opts.scenarioPath)

  if (!fs.existsSync(opts.appPath)) {
    throw new Error(`应用不存在: ${opts.appPath}`)
  }
  if (!fs.existsSync(scenarioPath)) {
    throw new Error(`场景不存在: ${scenarioPath}`)
  }

  const errors: string[] = []
  let completed = 0

  for (let i = 1; i <= repeats; i++) {
    deps.onProgress({ phase: 'run-start', runIndex: i, totalRuns: repeats, message: `第 ${i}/${repeats} 轮开始` })

    try {
      if (i > 1) {
        deps.onProgress({ phase: 'cleanup', runIndex: i, totalRuns: repeats, message: '结束上一轮残留进程…' })
        await deps.killTarget().catch(() => { /* 可能已无进程 */ })
        deps.resetRuntime()
        await sleep(between)
      } else if (deps.isSessionRunning()) {
        deps.onProgress({ phase: 'cleanup', runIndex: i, totalRuns: repeats, message: '结束上一会话…' })
        await deps.killTarget().catch(() => { /* ignore */ })
        await deps.endSession()
        deps.resetRuntime()
      }

      const appName = path.basename(opts.appPath).replace(/\.exe$/i, '')
      const sessionLabel = buildSessionLabel(opts.sessionPrefix, appName, i)
      const launchArgs = buildCdpArgs(cdpPort, opts.extraArgs ?? [])

      deps.onProgress({ phase: 'launch', runIndex: i, totalRuns: repeats, message: `启动应用 ${appName}` })
      const launched = await deps.launchApp(opts.appPath, launchArgs, sessionLabel, (msg) => {
        deps.onProgress({ phase: 'launch', runIndex: i, totalRuns: repeats, message: msg })
      })
      if (!launched.success) {
        throw new Error(launched.error ?? '启动失败')
      }

      deps.onProgress({ phase: 'cdp-wait', runIndex: i, totalRuns: repeats, message: `确认 CDP :${cdpPort}` })
      const cdpOk = await probeCdp(cdpPort, 8_000)
      if (!cdpOk) {
        throw new Error(`CDP :${cdpPort} 不可达，请确认应用支持调试端口`)
      }

      await deps.ensureMonitorActive?.(cdpPort, sessionLabel)

      if (warmup > 0) {
        deps.onProgress({ phase: 'warmup', runIndex: i, totalRuns: repeats, message: `预热 ${warmup}ms` })
        await sleep(warmup)
        await deps.ensureMonitorActive?.(cdpPort, sessionLabel)
      }

      deps.onProgress({ phase: 'scenario', runIndex: i, totalRuns: repeats, message: '执行场景脚本…' })
      await deps.ensureMonitorActive?.(cdpPort, sessionLabel)
      await runScenarioScript(scenarioPath, appRoot, cdpPort)
      deps.onProgress({ phase: 'scenario-done', runIndex: i, totalRuns: repeats, message: '场景脚本已结束，准备关闭会话…' })

      if (cooldown > 0) await sleep(cooldown)

      deps.onProgress({ phase: 'kill', runIndex: i, totalRuns: repeats, message: '关闭目标应用…' })
      await deps.killTarget().catch(() => { /* ignore */ })

      deps.onProgress({ phase: 'session-end', runIndex: i, totalRuns: repeats, message: '结束会话并落盘…' })
      await deps.endSession()
      deps.resetRuntime()

      completed += 1
      deps.onProgress({ phase: 'run-done', runIndex: i, totalRuns: repeats, message: `第 ${i} 轮完成 (${sessionLabel})` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`run ${i}: ${msg}`)
      deps.onProgress({ phase: 'run-error', runIndex: i, totalRuns: repeats, message: msg })
      try {
        await deps.killTarget()
      } catch { /* ignore */ }
      try {
        await deps.endSession()
      } catch { /* ignore */ }
      deps.resetRuntime()
    }
  }

  return { completed, errors }
}
