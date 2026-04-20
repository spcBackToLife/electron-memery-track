/**
 * Windows：根据根 PID 枚举进程子树（含根），并附带进程名。
 * 用于「启动并监控」后采集目标 exe 全进程树内存。
 */
import { execFile } from 'child_process'

export interface ProcessTreeResult {
  pids: number[]
  names: Map<number, string>
  /** Win32_Process.ExecutablePath */
  exePath: Map<number, string>
  /** Win32_Process.CommandLine */
  commandLine: Map<number, string>
}

export function fetchWindowsProcessTree(rootPid: number): Promise<ProcessTreeResult> {
  if (process.platform !== 'win32' || !Number.isFinite(rootPid) || rootPid <= 0) {
    return Promise.resolve({ pids: [], names: new Map(), exePath: new Map(), commandLine: new Map() })
  }

  const script = `
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$root = ${Math.floor(rootPid)}
$list = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
$children = @{}
$pidToDetail = @{}
foreach ($row in $list) {
  $ppid = [int]$row.ParentProcessId
  $procId = [int]$row.ProcessId
  $pidToDetail["$procId"] = @{ name = [string]$row.Name; exe = [string]$row.ExecutablePath; cmd = [string]$row.CommandLine }
  if (-not $children.ContainsKey($ppid)) { $children[$ppid] = New-Object System.Collections.Generic.List[int] }
  [void]$children[$ppid].Add($procId)
}
$seen = @{}
$queue = New-Object System.Collections.Queue
[void]$queue.Enqueue($root)
$pids = New-Object System.Collections.Generic.List[int]
while ($queue.Count -gt 0) {
  $cur = [int]$queue.Dequeue()
  if ($seen.ContainsKey($cur)) { continue }
  $seen[$cur] = $true
  [void]$pids.Add($cur)
  if ($children.ContainsKey($cur)) {
    foreach ($c in $children[$cur]) { [void]$queue.Enqueue($c) }
  }
}
$detailsObj = @{}
foreach ($p in $pids) {
  $key = "$p"
  if ($pidToDetail.ContainsKey($key)) { $detailsObj[$key] = $pidToDetail[$key] }
}
[PSCustomObject]@{ pids = $pids.ToArray(); details = $detailsObj } | ConvertTo-Json -Compress
`

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 12000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({ pids: [rootPid], names: new Map(), exePath: new Map(), commandLine: new Map() })
          return
        }
        try {
          const text = typeof stdout === 'string' ? stdout : String(stdout ?? '')
          const j = JSON.parse(text.trim()) as {
            pids: number[]
            details?: Record<string, { name?: string; exe?: string; cmd?: string }>
          }
          const pids =
            Array.isArray(j.pids) && j.pids.length > 0
              ? j.pids.map((n) => Number(n)).filter((n) => n > 0)
              : [rootPid]
          const names = new Map<number, string>()
          const exePath = new Map<number, string>()
          const commandLine = new Map<number, string>()
          if (j.details && typeof j.details === 'object') {
            for (const [k, d] of Object.entries(j.details)) {
              const id = parseInt(k, 10)
              if (isNaN(id)) continue
              if (d && typeof d.name === 'string') names.set(id, d.name)
              if (d && typeof d.exe === 'string' && d.exe.trim()) exePath.set(id, d.exe.trim())
              if (d && typeof d.cmd === 'string' && d.cmd.trim()) commandLine.set(id, d.cmd.trim())
            }
          }
          resolve({ pids, names, exePath, commandLine })
        } catch {
          resolve({ pids: [rootPid], names: new Map(), exePath: new Map(), commandLine: new Map() })
        }
      },
    )
  })
}
