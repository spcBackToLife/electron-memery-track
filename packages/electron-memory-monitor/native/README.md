# @electron-memory/native — Windows Native Memory Module

Get process memory details via Win32 API directly, **no external PowerShell process needed**.

## Why?

Electron's `app.getAppMetrics()` provides:
- `workingSetSize` — Working Set (includes shared DLL pages)
- `privateBytes` — Private Bytes / PrivateUsage (committed)

But Windows Task Manager's default "Memory" column shows **Private Working Set**, which Electron API does **NOT** provide.

| Approach | Latency | Accuracy | Overhead |
|----------|---------|----------|----------|
| PowerShell + WMI | 200-500ms | Good | Forks a process each time |
| **C++ Native Addon** | **< 5ms** | **Exact** | **In-process call** |

## How It Works

Uses `VirtualQueryEx` + `QueryWorkingSetEx` Win32 APIs:
1. Enumerate target process virtual address space
2. For each committed (MEM_COMMIT) region, batch query page attributes
3. Count `Valid && !Shared` pages × PAGE_SIZE = **exact Private Working Set**

This matches Windows Task Manager's `Working Set - Private` calculation.

## Building

### Prerequisites

- **Windows** OS
- **Node.js** >= 18
- **Python** 3.x (required by node-gyp)
- **Visual Studio Build Tools** or full Visual Studio (C++ Desktop workload)

### Install & Build

```bash
cd packages/electron-memory-monitor/native
npm install --ignore-scripts
npx node-gyp rebuild
```

### Build for Electron (Important!)

For Electron ABI compatibility, use Electron headers:

```bash
cd packages/electron-memory-monitor/native
npm install --ignore-scripts
npx node-gyp rebuild --target=33.2.1 --arch=x64 --dist-url=https://electronjs.org/headers
```

Or from SDK root:

```bash
cd packages/electron-memory-monitor
npm run build:native:electron
```

## API

```typescript
interface NativeMemory {
  // Get single process memory details
  getProcessMemoryDetails(pid: number): {
    workingSetSize: number     // Working Set (bytes)
    peakWorkingSetSize: number // Peak Working Set (bytes)
    privateUsage: number       // Private Bytes (bytes)
    pagefileUsage: number      // Pagefile Usage (bytes)
  } | null

  // Get single process exact Private Working Set (bytes), -1 on failure
  getPrivateWorkingSet(pid: number): number

  // Batch get Private Working Set: { "pid": bytes }
  batchGetPrivateWorkingSet(pids: number[]): Record<string, number>

  // Batch get process memory details (fast, no page enumeration)
  batchGetProcessMemory(pids: number[]): Record<string, object>
}
```

## Auto Fallback

The SDK's `collector.ts` uses `native-memory.ts` wrapper:
- ✅ Native module available → C++ in-process call, refresh interval as low as 500ms
- ⚠️ Native module unavailable → Auto fallback to PowerShell/WMI, refresh interval ≥ 2s
- ❌ Non-Windows → Not queried

No manual config needed. Backend status is auto-detected and logged at startup.
