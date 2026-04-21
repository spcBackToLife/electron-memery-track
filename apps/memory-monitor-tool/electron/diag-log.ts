/**
 * 诊断 NDJSON：默认写在「当前进程工作目录」下的 logs/mmt-diag.log（pnpm dev 时即 apps/memory-monitor-tool/logs，仓库里可见）。
 * 覆盖目录：环境变量 MMT_DIAG_LOG_DIR=绝对或相对路径
 */
import * as fs from 'fs'
import * as path from 'path'

let pathAnnounced = false

export function getDiagLogPath(): string | null {
  try {
    const dir =
      (process.env.MMT_DIAG_LOG_DIR && String(process.env.MMT_DIAG_LOG_DIR).trim()) ||
      path.join(process.cwd(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'mmt-diag.log')
  } catch {
    return null
  }
}

function announcePathOnce(p: string): void {
  if (pathAnnounced) return
  pathAnnounced = true
  console.log('[MMT:diag] log file:', p)
}

/**
 * @param skipConsole 渲染进程已在本地 console，避免主进程再打一遍
 */
export function writeDiagNdjson(record: Record<string, unknown>, skipConsole?: boolean): void {
  if (!skipConsole) {
    const src = String(record.source ?? '?')
    const tag = String(record.tag ?? '?')
    console.log(`[MMT:diag][${src}] ${tag}`, record)
  }
  const p = getDiagLogPath()
  if (!p) return
  announcePathOnce(p)
  const line = JSON.stringify(record) + '\n'
  try {
    fs.appendFileSync(p, line, 'utf-8')
  } catch (e) {
    console.error('[MMT:diag] appendFile failed', e)
  }
}

export function perfChainMain(tag: string, data?: Record<string, unknown>): void {
  writeDiagNdjson({ source: 'main', t: Date.now(), tag, ...data })
}
