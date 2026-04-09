/**
 * 看板静态资源通过自定义协议提供，避免 loadFile(file://) + ES module 在 asar 下白屏。
 * 使用显式 Content-Type + Uint8Array 响应体，避免 Buffer 在部分 Electron 版本下被误解码。
 *
 * Chromium 对自定义协议可能发出 emm-dashboard://assets/foo.js（host=assets, path=/foo），
 * 若只拼 pathname 会映射成 ui/foo.js 而错读文件，表现为乱码/白屏。
 */
import { app, net, protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEME = 'emm-dashboard'

let privilegedRegistered = false
let handlerRegistered = false

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

function isPathInsideRoot(filePath: string, root: string): boolean {
  const f = path.resolve(filePath)
  const r = path.resolve(root)
  if (f === r) {
    return true
  }
  const rel = path.relative(r, f)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false
  }
  return true
}

/** 将 request.url 映射为 ui 目录下的相对路径（POSIX 风格段，再交给 path.join） */
function urlToUiRelativePath(requestUrl: string): string {
  let u: URL
  try {
    u = new URL(requestUrl)
  }
  catch {
    return ''
  }
  let p = ''
  try {
    p = decodeURIComponent(u.pathname || '')
  }
  catch {
    p = u.pathname || ''
  }
  p = p.replace(/^\/+/, '')
  const host = (u.hostname || '').toLowerCase()

  if (p.includes('..')) {
    return ''
  }

  // 标准：emm-dashboard://electron/index.html 或 .../assets/xx.js
  if (host === 'electron' || host === '') {
    return p || 'index.html'
  }

  // Chromium 变体：emm-dashboard://assets/vendor.js → host=assets, pathname=/vendor.js
  if (p) {
    return `${host}/${p}`.replace(/\\/g, '/')
  }

  if (host.includes('.')) {
    return host
  }

  return 'index.html'
}

function bufferToResponseBody(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function looksLikeHtml(buf: Buffer): boolean {
  let i = 0
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    i = 3
  }
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0A || buf[i] === 0x0D)) {
    i += 1
  }
  return i < buf.length && buf[i] === 0x3C // <
}

/** 自定义协议下带 crossorigin 的 module 脚本会走 CORS，必须带 ACAO，否则脚本静默失败、白屏 */
function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  }
}

/**
 * 必须在 app.on('ready') 之前调用（与 new ElectronMemoryMonitor 同文件顶部或更早）。
 * 由 ElectronMemoryMonitor 在启用时于构造函数内调用。
 */
export function registerDashboardSchemePrivileged(): void {
  if (privilegedRegistered) {
    return
  }
  privilegedRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/**
 * 注册协议处理器；须在 app.isReady() 之后调用（SDK 在 start() → openDashboard 路径上满足）。
 * uiRoot：指向包内 dist/ui 目录（含 index.html 与 assets）。
 */
export function ensureDashboardProtocolHandler(uiRoot: string): void {
  if (handlerRegistered) {
    return
  }
  if (!app.isReady()) {
    throw new Error(
      '[@electron-memory/monitor] ensureDashboardProtocolHandler: app must be ready before opening dashboard',
    )
  }

  handlerRegistered = true
  const base = path.resolve(uiRoot)

  protocol.handle(SCHEME, async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    try {
      const rel = urlToUiRelativePath(request.url)
      if (!rel || rel.includes('..')) {
        return new Response('Bad path', { status: 400, headers: corsHeaders() })
      }
      const filePath = path.resolve(path.join(base, ...rel.split('/')))
      if (!isPathInsideRoot(filePath, base)) {
        return new Response('Forbidden', { status: 403, headers: corsHeaders() })
      }

      const fileUrl = pathToFileURL(filePath).href
      let upstream: Response
      try {
        upstream = await net.fetch(fileUrl)
      }
      catch {
        upstream = new Response(null, { status: 599 })
      }

      let buf: Buffer
      if (!upstream.ok) {
        buf = await readFile(filePath)
      }
      else {
        const ab = await upstream.arrayBuffer()
        buf = Buffer.from(ab)
      }

      const ext = path.extname(filePath).toLowerCase()
      if (ext === '.html' && !looksLikeHtml(buf)) {
        console.error(
          '[@electron-memory/monitor] emm-dashboard: not HTML at',
          filePath,
          'url=',
          request.url,
        )
        return new Response('Invalid dashboard HTML', { status: 500, headers: corsHeaders() })
      }

      const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
      return new Response(bufferToResponseBody(buf) as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          ...corsHeaders(),
        },
      })
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[@electron-memory/monitor] emm-dashboard:', request.url, err)
      return new Response(msg, { status: 404, headers: corsHeaders() })
    }
  })
}

/** 固定 host，保证相对资源 URL 解析正确（./assets/... → 同 origin） */
export function getDashboardPageURL(): string {
  return `${SCHEME}://electron/index.html`
}
