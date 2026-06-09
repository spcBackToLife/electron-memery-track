/**
 * 调用内存监控工具本地自动化 API
 */

const DEFAULT_MMT_URL = 'http://127.0.0.1:39271'

export function getMmtBaseUrl() {
  return (process.env.MMT_API_URL ?? DEFAULT_MMT_URL).replace(/\/$/, '')
}

export async function mmtHealth() {
  const res = await fetch(`${getMmtBaseUrl()}/api/health`)
  if (!res.ok) throw new Error(`MMT health ${res.status}`)
  return res.json()
}

export async function mmtStatus() {
  const res = await fetch(`${getMmtBaseUrl()}/api/status`)
  if (!res.ok) throw new Error(`MMT status ${res.status}`)
  return res.json()
}

export async function mmtMark(label, metadata) {
  const res = await fetch(`${getMmtBaseUrl()}/api/mark`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, metadata }),
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(body.error ?? `MMT mark failed ${res.status}`)
  }
  return body
}

function hintForStatus(st) {
  if (!st) return '监控工具未响应，请确认已 pnpm dev 启动'
  if (st.sessionRunning) return 'ok'
  if (!st.externalMonitor && !st.collecting) {
    return '请在监控工具中：搜索游戏进程 → 点「附加并监控」（会自动开始会话）'
  }
  if (st.externalMonitor && !st.sessionRunning) {
    return '已附加但无运行中会话：请再点一次「附加并监控」，或填写测试名后点「开始记录」'
  }
  return '请先在监控工具开始一次测试会话（附加并监控 或 开始记录）'
}

/** 等待监控工具里已有运行中的会话 */
export async function waitForMmtSession(timeoutMs = 120_000) {
  const start = Date.now()
  let lastHint = ''
  while (Date.now() - start < timeoutMs) {
    try {
      const st = await mmtStatus()
      if (st.sessionRunning) return st
      const hint = hintForStatus(st)
      if (hint !== lastHint) {
        console.log('[mmt] 当前:', JSON.stringify(st))
        console.log('[mmt] 提示:', hint)
        lastHint = hint
      } else {
        const elapsed = Math.floor((Date.now() - start) / 1000)
        process.stdout.write(`\r[mmt] 等待会话中… ${elapsed}s（可在等待期间去工具里点「附加并监控」）`)
      }
    } catch {
      if (lastHint !== 'offline') {
        console.log('[mmt] 无法连接自动化 API，请确认监控工具已启动 (pnpm dev)')
        lastHint = 'offline'
      }
    }
    await sleep(1000)
  }
  process.stdout.write('\n')
  throw new Error(
    `超时：${timeoutMs}ms 内未检测到运行中的监控会话。\n` +
      '操作顺序：① pnpm dev 打开监控工具 ② 被测应用带 --remote-debugging-port=9222 ③ 工具里附加游戏进程 ④ 再跑 pnpm scenario:launcher\n' +
      '或设置 SKIP_MMT_SESSION=1 仅测试点击（不打 mark）',
  )
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
