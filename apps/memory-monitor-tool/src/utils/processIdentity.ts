/**
 * 跨会话 / 跨批量轮次的进程身份与展示（与实时监控 ProcessTable 口径一致）
 */
import type { MemorySnapshot, ProcessMemoryInfo } from '../types'

/** 从完整命令行提取 Chromium --type=（及 utility 子类型） */
export function parseChromiumProcessRole(cmd: string | undefined): string | undefined {
  if (cmd == null || typeof cmd !== 'string') return undefined
  const trimmed = cmd.trim()
  if (!trimmed) return undefined
  const typeM = trimmed.match(/--type=([^\s"']+)/i)
  if (!typeM?.[1]) return undefined
  const raw = typeM[1]
  const t = raw.toLowerCase()
  if (t === 'utility') {
    const subM = trimmed.match(/--utility-sub-type=([^\s"']+)/i)
    const sub = subM?.[1] ?? ''
    const combo = sub ? `utility:${sub}` : 'utility'
    return combo.length > 96 ? `${combo.slice(0, 93)}…` : combo
  }
  return raw.length > 64 ? `${raw.slice(0, 61)}…` : raw
}

const TYPE_COLORS: Record<string, string> = {
  Browser: '#646cff',
  Tab: '#61dafb',
  GPU: '#f5a623',
}

function chromiumTypeLabel(raw: string): string {
  const t = raw.split(':')[0]?.toLowerCase() ?? raw.toLowerCase()
  if (t === 'gpu-process') return 'GPU'
  if (t === 'renderer') return '渲染'
  if (t === 'browser') return '浏览器'
  if (t === 'utility') return 'Utility'
  if (t === 'crashpad-handler') return 'Crashpad'
  if (t === 'zygote') return 'Zygote'
  return raw.length > 20 ? `${raw.slice(0, 18)}…` : raw
}

/** 与 ProcessTable externalTypeBadge 一致 */
export function getExternalProcessTypeBadge(
  proc: ProcessMemoryInfo,
): { label: string; color: string; title?: string } {
  if (proc.type === 'Browser') {
    return { label: '主进程', color: TYPE_COLORS.Browser!, title: proc.chromiumType }
  }
  if (proc.chromiumType) {
    const t = proc.chromiumType.split(':')[0]?.toLowerCase() ?? ''
    const color = t === 'gpu-process' ? TYPE_COLORS.GPU!
      : t === 'renderer' ? TYPE_COLORS.Tab!
      : t === 'browser' ? TYPE_COLORS.Browser!
      : '#888'
    return { label: chromiumTypeLabel(proc.chromiumType), color, title: proc.chromiumType }
  }
  if (proc.type === 'GPU') return { label: 'GPU', color: TYPE_COLORS.GPU! }
  if (proc.type === 'Utility') return { label: '辅助进程', color: '#8b6ec8' }
  if (proc.type === 'Zygote') return { label: 'Zygote', color: '#4a7a8f' }
  return { label: '子进程', color: TYPE_COLORS.Tab! }
}

function stableExeKey(raw: string | undefined): string | null {
  const t = raw?.trim()
  if (!t) return null
  return t.replace(/\//g, '\\').toLowerCase()
}

/** 去掉轮次间会变的 PID、句柄等，保留 --type= 等稳定参数 */
export function normalizeCommandLineForIdentity(cmd: string): string {
  let s = cmd.trim().replace(/\s+/g, ' ')
  s = s.replace(/--renderer-client-id=\d+/gi, '--renderer-client-id=#')
  s = s.replace(/--mojo-platform-channel-handle=\d+/gi, '--mojo-platform-channel-handle=#')
  s = s.replace(/--field-trial-handle=[^\s"']+/gi, '--field-trial-handle=#')
  s = s.replace(/--metrics-shmem-handle=\d+,[^\s"']+/gi, '--metrics-shmem-handle=#')
  s = s.replace(/\b(pid|process-id)=\d+/gi, '$1=#')
  s = s.replace(/\b\d{5,}\b/g, '#')
  return s.toLowerCase()
}

function stableCmdKey(raw: string | undefined): string | null {
  const t = raw?.trim()
  if (!t) return null
  const norm = normalizeCommandLineForIdentity(t)
  return norm || null
}

/**
 * 跨轮匹配身份：
 * - Chromium：主进程/GPU/Utility 按 role+exe（每类一条）
 * - 渲染等：role+exe+归一化 cmd（去掉 PID/句柄）
 * - 其它：归一化 cmd → exe → name
 */
export function identityKeyForProc(p: ProcessMemoryInfo, sn: MemorySnapshot): string {
  const cmd = p.commandLine?.trim() || ''
  const chromeRole = (p.chromiumType || parseChromiumProcessRole(cmd))?.toLowerCase()
  const exeK = stableExeKey(p.executablePath) || p.name?.trim().toLowerCase() || 'proc'

  if (chromeRole) {
    const base = chromeRole.split(':')[0] ?? chromeRole
    if (base === 'browser' || base === 'gpu-process' || chromeRole.startsWith('utility:')) {
      return `role:${exeK}:${chromeRole}`
    }
    const norm = stableCmdKey(cmd)
    if (norm) return `role:${exeK}:${chromeRole}:${norm}`
    return `role:${exeK}:${chromeRole}`
  }

  const cmdK = stableCmdKey(cmd)
  if (cmdK) return `cmd:${cmdK}`

  const exeOnly = stableExeKey(p.executablePath)
  if (exeOnly) return `exe:${exeOnly}`

  if (sn.monitorMode === 'external' && p.name?.trim()) {
    return `name:${p.name.trim().toLowerCase()}`
  }
  return `pid:${p.pid}`
}

export function pickRepresentativeProc(
  runs: Array<{ snapshots: MemorySnapshot[] }>,
  identityKey: string,
): ProcessMemoryInfo | undefined {
  for (const r of runs) {
    for (let i = r.snapshots.length - 1; i >= 0; i--) {
      for (const p of r.snapshots[i]!.processes) {
        if (identityKeyForProc(p, r.snapshots[i]!) === identityKey) return p
      }
    }
  }
  return undefined
}

export function formatCmdPreview(cmd: string | undefined, maxLen = 96): string {
  const t = cmd?.trim()
  if (!t) return '（无命令行）'
  const one = t.replace(/\s+/g, ' ')
  return one.length > maxLen ? `${one.slice(0, maxLen - 1)}…` : one
}

export interface ProcessIdentityDisplay {
  identityKey: string
  typeLabel: string
  processName: string
  cmdPreview: string
  cmdFull: string
  optionLabel: string
  peakMB: number
  /** 有多少轮出现过该身份且至少一拍内存 > 0 */
  runCoverage: number
  totalRuns: number
}

export function describeProcessIdentity(
  identityKey: string,
  proc: ProcessMemoryInfo | undefined,
  peakMB: number,
  runCoverage: number,
  totalRuns: number,
): ProcessIdentityDisplay {
  const badge = proc ? getExternalProcessTypeBadge(proc) : { label: '进程', color: '#888' }
  const processName = proc?.name?.trim()
    || proc?.executablePath?.split(/[/\\]/).pop()
    || identityKey
  const cmdFull = proc?.commandLine?.trim() || ''
  const cmdPreview = formatCmdPreview(cmdFull)
  const cov = totalRuns > 1 ? ` · ${runCoverage}/${totalRuns}轮` : ''
  const optionLabel = `[${badge.label}] ${processName} | ${cmdPreview}${cov}`

  return {
    identityKey,
    typeLabel: badge.label,
    processName,
    cmdPreview,
    cmdFull,
    optionLabel,
    peakMB,
    runCoverage,
    totalRuns,
  }
}
