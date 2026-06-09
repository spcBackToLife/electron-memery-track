/**
 * 通过 CDP 连接 Electron 并选取目标 Page
 */

export function getCdpUrl() {
  return process.env.CDP_URL ?? 'http://127.0.0.1:9222'
}

/** 探测 CDP HTTP 是否可达（不经过 Playwright） */
export async function probeCdpEndpoint(cdpUrl = getCdpUrl()) {
  const base = cdpUrl.replace(/\/$/, '')
  try {
    const versionRes = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!versionRes.ok) {
      return { ok: false, error: `HTTP ${versionRes.status} on /json/version` }
    }
    const version = await versionRes.json()
    const listRes = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(3000) })
    const pages = listRes.ok ? await listRes.json() : []
    return {
      ok: true,
      browser: version.Browser ?? version.browser,
      pageCount: Array.isArray(pages) ? pages.length : 0,
      pages: (Array.isArray(pages) ? pages : []).slice(0, 8).map((p) => ({
        title: p.title,
        url: p.url,
      })),
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

function formatCdpTroubleshoot(cdpUrl) {
  return [
    `CDP 连接失败 (${cdpUrl})：本机没有进程在监听该端口。`,
    '',
    '你加了 --remote-debugging-port=9222 但仍 ECONNREFUSED，通常是：',
    '  • 参数加在启动器/外层 exe，真正显示界面的 Electron 子进程没继承该参数',
    '  • 监控附加的是 DB_王者万象棋.exe，但 CDP 可能在另一个进程（看 netstat 的 PID）',
    '  • 需在「最终拉起窗口」的那个 exe 上带端口，或代码里 appendSwitch',
    '',
    '自检：',
    `  1. 浏览器打开 ${cdpUrl.replace(/\/$/, '')}/json — 应看到页面 JSON`,
    '  2. 运行: pnpm scenario:check-cdp',
    '  3. 尝试启动: your-app.exe --remote-debugging-port=9222 --remote-allow-origins=*',
  ].join('\n')
}

export async function connectBrowser(playwright) {
  const { chromium } = playwright
  const cdpUrl = getCdpUrl()
  console.log('[cdp] connect', cdpUrl)

  const probe = await probeCdpEndpoint(cdpUrl)
  if (!probe.ok) {
    console.error('\n' + formatCdpTroubleshoot(cdpUrl) + '\n')
    throw new Error(`CDP 不可达: ${probe.error}`)
  }
  console.log('[cdp] 探测 OK, pages:', probe.pageCount)

  return chromium.connectOverCDP(cdpUrl)
}

export async function listPages(browser) {
  const rows = []
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      rows.push({
        page,
        url: page.url(),
        title: await page.title().catch(() => ''),
      })
    }
  }
  return rows
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{ pageUrlIncludes?: string }} [opts]
 */
export async function pickMainPage(browser, opts = {}) {
  const pages = await listPages(browser)
  if (pages.length === 0) {
    throw new Error('CDP 下没有页面。请确认被测应用已用 --remote-debugging-port=9222 启动。')
  }

  for (const row of pages) {
    console.log('[cdp] page:', row.url, '|', row.title)
  }

  const needle = opts.pageUrlIncludes?.trim()
  if (needle) {
    const hit = pages.find((p) => p.url.includes(needle))
    if (hit) {
      console.log('[cdp] 选用 (pageUrlIncludes):', hit.url)
      return hit.page
    }
  }

  const candidate =
    pages.find((p) => !p.url.includes('devtools://') && !p.url.startsWith('about:blank')) ??
    pages[0]

  console.log('[cdp] 选用:', candidate.url)
  return candidate.page
}
