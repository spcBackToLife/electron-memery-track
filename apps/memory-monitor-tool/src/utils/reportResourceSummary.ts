/** 报告 dataPoints 中的外部资源汇总（主进程写 report.json 与报告页展示共用逻辑） */

export type ReportDataPointLike = {
  extCpuPercent?: number
  extDiskReadKBps?: number
  extDiskWriteKBps?: number
  extGpuEnginePercent?: number | null
  extGpuDedicatedMB?: number | null
}

export type ResourceSummaryPayload = {
  sampleCount: number
  peakCpuPercent: number
  avgCpuPercent: number
  finalCpuPercent: number
  peakDiskReadKBps: number
  avgDiskReadKBps: number
  finalDiskReadKBps: number
  peakDiskWriteKBps: number
  avgDiskWriteKBps: number
  finalDiskWriteKBps: number
  peakGpuEnginePercent: number | null
  avgGpuEnginePercent: number | null
  finalGpuEnginePercent: number | null
  peakGpuDedicatedMB: number | null
  avgGpuDedicatedMB: number | null
  finalGpuDedicatedMB: number | null
}

export function computeResourceSummaryFromDataPoints(
  dataPoints: ReportDataPointLike[],
): ResourceSummaryPayload | undefined {
  const ext = dataPoints.filter((p) => p.extCpuPercent !== undefined)
  if (ext.length === 0) return undefined

  const round1 = (x: number) => Math.round(x * 10) / 10
  const cpus = ext.map((p) => p.extCpuPercent as number)
  const reads = ext.map((p) => p.extDiskReadKBps ?? 0)
  const writes = ext.map((p) => p.extDiskWriteKBps ?? 0)
  const gpus = ext.map((p) => p.extGpuEnginePercent ?? null)
  const vrams = ext.map((p) => p.extGpuDedicatedMB ?? null)

  const avgArr = (arr: number[]) => round1(arr.reduce((a, b) => a + b, 0) / arr.length)
  const peakArr = (arr: number[]) => round1(Math.max(...arr))

  const gpuNums = gpus.filter((x): x is number => x != null && Number.isFinite(x))
  const vramNums = vrams.filter((x): x is number => x != null && Number.isFinite(x))

  const lastGpu = ext[ext.length - 1]!.extGpuEnginePercent ?? null
  const lastVram = ext[ext.length - 1]!.extGpuDedicatedMB ?? null

  return {
    sampleCount: ext.length,
    peakCpuPercent: peakArr(cpus),
    avgCpuPercent: avgArr(cpus),
    finalCpuPercent: round1(cpus[cpus.length - 1]!),
    peakDiskReadKBps: peakArr(reads),
    avgDiskReadKBps: avgArr(reads),
    finalDiskReadKBps: round1(reads[reads.length - 1]!),
    peakDiskWriteKBps: peakArr(writes),
    avgDiskWriteKBps: avgArr(writes),
    finalDiskWriteKBps: round1(writes[writes.length - 1]!),
    peakGpuEnginePercent: gpuNums.length ? peakArr(gpuNums) : null,
    avgGpuEnginePercent: gpuNums.length ? avgArr(gpuNums) : null,
    finalGpuEnginePercent:
      lastGpu != null && Number.isFinite(lastGpu) ? round1(lastGpu) : null,
    peakGpuDedicatedMB: vramNums.length ? peakArr(vramNums) : null,
    avgGpuDedicatedMB: vramNums.length ? avgArr(vramNums) : null,
    finalGpuDedicatedMB:
      lastVram != null && Number.isFinite(lastVram) ? round1(lastVram) : null,
  }
}
