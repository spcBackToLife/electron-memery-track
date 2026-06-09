#!/usr/bin/env node
/**
 * 连续执行多轮场景（每轮之间需你手动重启被测应用并重新开始监控会话，或按提示操作）。
 *
 *   REPEAT=3 pnpm scenario:batch
 *   REPEAT=5 SCENARIO=scripts/scenarios/my.scenario.json pnpm scenario:batch
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repeat = Math.max(1, parseInt(process.env.REPEAT ?? '3', 10) || 3)
const scenario = process.env.SCENARIO ?? 'scripts/scenarios/example.scenario.json'
const pauseBetweenMs = parseInt(process.env.BETWEEN_RUNS_MS ?? '5000', 10) || 5000

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close()
      resolve(ans)
    })
  })
}

function runScenarioOnce(runIndex) {
  return new Promise((resolve, reject) => {
    const runner = path.join(__dirname, 'scenario-runner.mjs')
    const child = spawn(process.execPath, [runner, scenario], {
      stdio: 'inherit',
      env: { ...process.env, RUN_INDEX: String(runIndex) },
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`scenario-runner exit ${code}`))
    })
  })
}

async function main() {
  console.log(`批量执行: ${repeat} 轮, 场景=${scenario}\n`)

  for (let i = 1; i <= repeat; i++) {
    console.log(`\n######## 第 ${i}/${repeat} 轮 ########`)
    if (i > 1) {
      console.log('请：1) 重启被测应用（带 --remote-debugging-port=9222）')
      console.log('     2) 监控工具重新附加并开始新会话')
      await ask('准备好后按 Enter 继续…')
    } else {
      console.log('请确认：被测应用已启动(9222)、监控工具已附加且「开始记录」')
      await ask('按 Enter 开始本轮…')
    }

    await runScenarioOnce(i)
    console.log(`第 ${i} 轮完成。请在监控工具点击「结束会话」保存报告。`)

    if (i < repeat) {
      await new Promise((r) => setTimeout(r, pauseBetweenMs))
    }
  }

  console.log('\n全部轮次完成。可到「对比」页选择多次会话比较。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
