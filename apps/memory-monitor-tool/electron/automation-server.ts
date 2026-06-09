/**
 * 本地 HTTP API：供 Playwright 场景脚本调用（打 mark、查会话状态）。
 * 仅监听 127.0.0.1，默认端口 39271（可用环境变量 MMT_AUTOMATION_PORT 覆盖）。
 */

import * as http from 'http'

const DEFAULT_PORT = 39271

export interface AutomationStatus {
  sessionRunning: boolean
  sessionId: string | null
  sessionLabel: string | null
  collecting: boolean
  externalMonitor: boolean
  externalRootPid: number | null
}

export interface LaunchMonitorBody {
  appPath: string
  args?: string[]
  cdpPort?: number
}

export interface AutomationServerDeps {
  queueMark: (label: string, metadata?: Record<string, unknown>) => void
  getStatus: () => AutomationStatus
  endSession?: () => Promise<unknown>
  launchMonitor?: (body: LaunchMonitorBody) => Promise<{ ok: boolean; error?: string; sessionId?: string }>
  killTarget?: () => Promise<void>
}

let server: http.Server | null = null
let listeningPort: number | null = null

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function getAutomationServerPort(): number | null {
  return listeningPort
}

export function getAutomationBaseUrl(): string | null {
  return listeningPort != null ? `http://127.0.0.1:${listeningPort}` : null
}

export function startAutomationServer(deps: AutomationServerDeps, preferredPort?: number): Promise<number> {
  if (server) {
    return Promise.resolve(listeningPort ?? preferredPort ?? DEFAULT_PORT)
  }

  const port = preferredPort
    ?? (process.env.MMT_AUTOMATION_PORT ? parseInt(process.env.MMT_AUTOMATION_PORT, 10) : DEFAULT_PORT)

  return new Promise((resolve, reject) => {
    const s = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const method = req.method ?? 'GET'

      try {
        if (method === 'GET' && url.pathname === '/api/health') {
          sendJson(res, 200, { ok: true, port: listeningPort })
          return
        }

        if (method === 'GET' && url.pathname === '/api/status') {
          sendJson(res, 200, deps.getStatus())
          return
        }

        if (method === 'POST' && url.pathname === '/api/session/stop') {
          if (!deps.endSession) {
            sendJson(res, 501, { ok: false, error: 'endSession not configured' })
            return
          }
          await deps.endSession()
          sendJson(res, 200, { ok: true })
          return
        }

        if (method === 'POST' && url.pathname === '/api/launch-monitor') {
          if (!deps.launchMonitor) {
            sendJson(res, 501, { ok: false, error: 'launchMonitor not configured' })
            return
          }
          const body = (await readJsonBody(req)) as LaunchMonitorBody
          const appPath = typeof body.appPath === 'string' ? body.appPath.trim() : ''
          if (!appPath) {
            sendJson(res, 400, { ok: false, error: 'appPath is required' })
            return
          }
          const result = await deps.launchMonitor(body)
          sendJson(res, result.ok ? 200 : 500, result)
          return
        }

        if (method === 'POST' && url.pathname === '/api/target/kill') {
          if (!deps.killTarget) {
            sendJson(res, 501, { ok: false, error: 'killTarget not configured' })
            return
          }
          await deps.killTarget()
          sendJson(res, 200, { ok: true })
          return
        }

        if (method === 'POST' && url.pathname === '/api/mark') {
          const body = (await readJsonBody(req)) as { label?: unknown; metadata?: unknown }
          const label = typeof body.label === 'string' ? body.label.trim() : ''
          if (!label) {
            sendJson(res, 400, { ok: false, error: 'label is required' })
            return
          }
          const metadata =
            body.metadata != null && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
              ? (body.metadata as Record<string, unknown>)
              : undefined
          deps.queueMark(label, metadata)
          sendJson(res, 200, { ok: true, label, timestamp: Date.now() })
          return
        }

        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })

    s.on('error', reject)
    s.listen(port, '127.0.0.1', () => {
      server = s
      const addr = s.address()
      listeningPort = typeof addr === 'object' && addr ? addr.port : port
      console.log(`[MonitorTool] 自动化 API: http://127.0.0.1:${listeningPort}`)
      resolve(listeningPort)
    })
  })
}

export function stopAutomationServer(): void {
  if (!server) return
  server.close()
  server = null
  listeningPort = null
}
