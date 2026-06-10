#!/usr/bin/env node
/**
 * 将 Playwright 录制代码转为 scenario JSON（click + wait + mark）
 *
 *   pnpm scenario:from-playwright 想法.md
 *   pnpm scenario:from-playwright 想法.md -o scripts/scenarios/my.scenario.json
 */

import fs from 'node:fs'
import path from 'node:path'

const STEP_DELAY_MS = parseInt(process.env.STEP_DELAY_MS ?? '5000', 10) || 5000

function parseClickLine(line) {
  const t = line.trim()
  if (!t.includes('.click()')) return null

  let m = t.match(/getByText\(\s*['"](.+?)['"]\s*(?:,\s*\{[^}]*\})?\s*\)\.click\(\)/)
  if (m) return { kind: 'text', value: m[1], exact: t.includes('exact: true') }

  m = t.match(/getByRole\(\s*['"](.+?)['"]\s*,\s*\{\s*name:\s*['"](.+?)['"]\s*\}\s*\)\.click\(\)/)
  if (m) return { kind: 'role', role: m[1], name: m[2] }

  m = t.match(/locator\(\s*['"](.+?)['"]\s*\)\.click\(\)/)
  if (m && !t.includes('.filter(')) return { kind: 'css', value: m[1] }

  m = t.match(/locator\(\s*['"](.+?)['"]\s*\)\.filter\(\s*\{\s*hasText:\s*(\/.+?\/|\/.+?\/[gimsuy]*)\s*\}\s*\)\.nth\((\d+)\)\.click\(\)/)
  if (m) {
    const raw = m[2]
    const regex = raw.startsWith('/') && raw.length > 2
    const pattern = regex ? raw.slice(1, raw.lastIndexOf('/')) : raw
    return {
      kind: 'css',
      value: m[1],
      filter: { hasText: pattern, regex },
      nth: parseInt(m[3], 10),
    }
  }

  return { kind: 'css', value: t, note: '未解析，请手改' }
}

function noteFromLocator(loc) {
  if (loc.kind === 'text') return loc.value
  if (loc.kind === 'role') return `${loc.role}-${loc.name}`
  if (loc.kind === 'css' && loc.value.startsWith('#')) return loc.value.slice(1)
  return loc.value?.slice(0, 24) ?? 'click'
}

export function convertPlaywrightSource(source, name, stepDelayMs = STEP_DELAY_MS) {
  const steps = [{ type: 'mark', label: 'scenario-start' }]
  const lines = source.split('\n')
  let idx = 0

  for (const line of lines) {
    if (!line.includes('.click()')) continue
    const locator = parseClickLine(line)
    if (!locator) continue
    idx += 1
    const note = noteFromLocator(locator)
    steps.push({
      type: 'click',
      note,
      markAfterClick: false,
      locator,
    })
    steps.push({ type: 'wait', ms: stepDelayMs })
    steps.push({ type: 'mark', label: `after-${note}` })
  }

  steps.push({ type: 'mark', label: 'scenario-end' })

  return {
    name: name || 'converted-scenario',
    description: `由 playwright-to-scenario 自动生成，每步 wait ${stepDelayMs}ms + mark`,
    cdpUrl: 'http://127.0.0.1:9222',
    mmtApiUrl: 'http://127.0.0.1:39271',
    requireMmtSession: true,
    steps,
  }
}

function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('-o')
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null
  const inPath = args.find((a, i) => a !== '-o' && i !== outIdx + 1)
  if (!inPath) {
    console.error('用法: node playwright-to-scenario.mjs <录制文件> [-o 输出.json]')
    process.exit(1)
  }

  const abs = path.resolve(process.cwd(), inPath)
  const source = fs.readFileSync(abs, 'utf-8')
  const base = path.basename(abs, path.extname(abs))
  const scenario = convertPlaywrightSource(source, base)

  const target = outPath
    ? path.resolve(process.cwd(), outPath)
    : path.join(path.dirname(abs), `${base}.scenario.json`)

  fs.writeFileSync(target, JSON.stringify(scenario, null, 2), 'utf-8')
  console.log('已生成:', target)
  console.log('步骤数:', scenario.steps.length, `(含 ${scenario.steps.filter((s) => s.type === 'click').length} 次点击)`)
}

main()
