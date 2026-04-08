/**
 * 批量运行基准测试脚本
 *
 * 用法：
 *   npx tsx scripts/run-benchmark.ts
 *   npx tsx scripts/run-benchmark.ts --scenario bare-minimum --duration 60
 */

import { execSync, spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

interface BenchmarkConfig {
  scenario: string
  duration: number // 秒
  windowCount?: number
}

const SCENARIOS: BenchmarkConfig[] = [
  { scenario: 'bare-minimum', duration: 120 },
  { scenario: 'single-window', duration: 120 },
  { scenario: 'multi-window', duration: 120, windowCount: 2 },
  { scenario: 'multi-window', duration: 120, windowCount: 5 },
  { scenario: 'multi-window', duration: 120, windowCount: 10 },
  { scenario: 'heavy-renderer', duration: 180 },
  { scenario: 'ipc-stress', duration: 180 },
  { scenario: 'real-world-sim', duration: 180 },
]

async function runScenario(config: BenchmarkConfig): Promise<void> {
  const label = config.windowCount
    ? `${config.scenario} × ${config.windowCount}`
    : config.scenario

  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 运行场景: ${label}`)
  console.log(`   持续时间: ${config.duration}s`)
  console.log(`${'='.repeat(60)}\n`)

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  }
  if (config.windowCount) {
    env.WINDOW_COUNT = String(config.windowCount)
  }

  // 使用子进程运行
  const appDir = path.join(process.cwd(), 'apps', config.scenario)
  const child: ChildProcess = spawn('npx', ['electron', '.'], {
    cwd: appDir,
    env,
    stdio: 'inherit',
    shell: true,
  })

  // 等待指定时长后终止
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      console.log(`\n⏱️  ${label}: 达到 ${config.duration}s，正在停止...`)
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolve()
      }, 5000)
    }, config.duration * 1000)

    child.on('exit', () => resolve())
  })

  console.log(`✅ ${label}: 完成\n`)
}

async function main() {
  const args = process.argv.slice(2)
  const scenarioFilter = args.includes('--scenario')
    ? args[args.indexOf('--scenario') + 1]
    : null
  const durationOverride = args.includes('--duration')
    ? parseInt(args[args.indexOf('--duration') + 1])
    : null

  let scenarios = SCENARIOS
  if (scenarioFilter) {
    scenarios = scenarios.filter((s) => s.scenario === scenarioFilter)
  }
  if (durationOverride) {
    scenarios = scenarios.map((s) => ({ ...s, duration: durationOverride }))
  }

  console.log('📊 Electron 内存基准测试')
  console.log(`   场景数: ${scenarios.length}`)
  console.log(`   报告目录: ${path.join(process.cwd(), 'reports')}`)
  console.log('')

  for (const config of scenarios) {
    await runScenario(config)
  }

  console.log('\n🎉 所有基准测试完成！')
  console.log('   报告已保存到各场景 App 的 userData 目录下')
  console.log('   可通过监控面板的"历史报告"页面查看')
}

main().catch(console.error)
