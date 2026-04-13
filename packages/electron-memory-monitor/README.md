# @electron-memory/monitor

Zero-intrusion memory profiling SDK for Electron applications.

---

## 📦 Building the SDK

### Prerequisites (Windows)

- **Node.js** >= 18
- **Python** 3.x (required by node-gyp)
- **Visual Studio Build Tools** (C++ Desktop workload) or full Visual Studio
- **pnpm** >= 8

> Native C++ module only supports Windows. On macOS/Linux the SDK automatically falls back to alternative data sources.

### One Command Build

From the **monorepo root**:

```bash
pnpm build:sdk
```

Or from the **SDK package directory**:

```bash
cd packages/electron-memory-monitor
npm run build
```

This single command does **everything**:

1. **Compile C++ native module** (`node-gyp rebuild` targeting Electron 33.2.1)
2. **Bundle TypeScript** (tsup → `dist/index.js` + `dist/index.mjs`)
3. **Build Dashboard UI** (vite → `dist/ui/`)
4. **Copy `.node` binary** → `dist/native/memory_native.node`

Final `dist/` structure:

```
dist/
├── index.js / index.mjs        # SDK main entry (CJS + ESM)
├── index.d.ts / index.d.mts    # Type declarations
├── preload.js / preload.mjs    # Optional preload entry
├── dashboard-preload.js        # Internal dashboard preload
├── native/
│   └── memory_native.node      # Pre-compiled Windows native addon
└── ui/
    └── index.html + assets/    # Dashboard UI
```

### Build Variants

| Command (SDK dir) | What it does |
|---|---|
| `npm run build` | **Full build**: native + TS + UI + copy (recommended) |
| `npm run build:skip-native` | Skip native compilation, only TS + UI + copy existing `.node` |
| `npm run build:native:electron` | Only compile the C++ native module for Electron |
| `npm run rebuild:native` | Re-compile native module (same as `build:native:electron`) |
| `npm run build:node` | Only build TypeScript (tsup) |
| `npm run build:ui` | Only build Dashboard UI (vite) |

| Command (monorepo root) | What it does |
|---|---|
| `pnpm build:sdk` | Full SDK build (same as `npm run build` in SDK dir) |
| `pnpm build:sdk:skip-native` | Build SDK without re-compiling native module |
| `pnpm build:all` | Build SDK + all demo apps |

### Targeting a Different Electron Version

If your project uses a different Electron version, rebuild the native module:

```bash
cd packages/electron-memory-monitor/native
npm install --ignore-scripts
npx node-gyp rebuild --target=<YOUR_ELECTRON_VERSION> --arch=x64 --dist-url=https://electronjs.org/headers
```

Then rebuild the SDK:

```bash
npm run build:skip-native
```

---

## 🚀 Publishing

```bash
cd packages/electron-memory-monitor
npm publish --access public
```

The published package includes:

| Path | Contents |
|---|---|
| `dist/` | Pre-built JS, UI, and **pre-compiled `.node` binary** |
| `native/src/` | C++ source code (for users who need to recompile) |
| `native/binding.gyp` | Build configuration |
| `native/package.json` | Native module metadata |

> The `.node` binary is platform-specific (Windows x64). Users on the same platform get native performance out of the box. On other platforms, the SDK falls back automatically.

---

## 📥 Installation (In Your Electron Project)

```bash
# pnpm (recommended)
pnpm add @electron-memory/monitor

# npm
npm install @electron-memory/monitor

# yarn
yarn add @electron-memory/monitor
```

### Basic Usage

```typescript
// main.ts (Electron main process)
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

new ElectronMemoryMonitor()  // That's it!
```

The SDK automatically:
1. Loads the pre-compiled native module (if available)
2. Falls back to PowerShell/WMI if native module can't load
3. Starts collecting memory data from all processes
4. Opens the monitoring dashboard

### With Configuration

```typescript
import { ElectronMemoryMonitor } from '@electron-memory/monitor'

const monitor = new ElectronMemoryMonitor({
  enabled: process.env.NODE_ENV !== 'production',
  collectInterval: 2000,
  openDashboardOnStart: true,
  processLabels: {
    'My App': 'Main Window',
  },
})
```

---

## 🏗️ Electron App Packaging (electron-builder / electron-forge)

The native `.node` file is a **binary addon** — it won't be bundled by Webpack/Vite/esbuild. You need to configure your Electron packager to include it as an **unpacked native dependency**.

### electron-builder

```yaml
# electron-builder.yml
asarUnpack:
  - "node_modules/@electron-memory/monitor/dist/native/**"
  - "node_modules/@electron-memory/monitor/native/build/Release/**"

files:
  - "dist/**/*"
  - "node_modules/**/*"

extraResources: []
```

Or in `package.json`:

```json
{
  "build": {
    "asarUnpack": [
      "node_modules/@electron-memory/monitor/dist/native/**",
      "node_modules/@electron-memory/monitor/native/build/Release/**"
    ]
  }
}
```

**Why `asarUnpack`?** — `.node` files cannot be loaded from inside an `.asar` archive. `asarUnpack` extracts them to `app.asar.unpacked/` so Node.js can `require()` them normally.

### electron-forge

```javascript
// forge.config.js
module.exports = {
  packagerConfig: {
    asar: {
      unpack: '{**/node_modules/@electron-memory/monitor/dist/native/**,**/node_modules/@electron-memory/monitor/native/build/Release/**}'
    }
  },
}
```

### vite-plugin-electron (vite + electron)

If you use `vite-plugin-electron` (like the demo apps in this repo), the main process code is bundled by Vite. Native `.node` modules need to be **externalized**:

```typescript
// vite.config.ts
import electron from 'vite-plugin-electron'

export default {
  plugins: [
    electron({
      entry: 'electron/main.ts',
      vite: {
        build: {
          rollupOptions: {
            external: [
              // Externalize the native .node module so it's not bundled
              /\.node$/,
              '@electron-memory/monitor',
            ],
          },
        },
      },
    }),
  ],
}
```

### Re-compiling for Your Electron Version

If the pre-compiled `.node` doesn't work (e.g., different Electron version or architecture):

```bash
cd node_modules/@electron-memory/monitor
npm run rebuild:native
```

Or manually:

```bash
cd node_modules/@electron-memory/monitor/native
npm install --ignore-scripts
npx node-gyp rebuild --target=<YOUR_ELECTRON_VERSION> --arch=x64 --dist-url=https://electronjs.org/headers
```

Then restart your Electron app — the SDK picks up the new binary automatically.

---

## 🔍 How Native Module Loading Works

At runtime, the SDK searches for `memory_native.node` in this order:

1. `<sdk_dist>/native/memory_native.node` — Pre-compiled binary (published with the package)
2. `<sdk_root>/native/build/Release/memory_native.node` — Locally compiled binary
3. `<source>/../../native/build/Release/memory_native.node` — Development path

If **none** are found, the SDK automatically falls back to **PowerShell/WMI** (slower, ~200-500ms per collection vs <5ms for native).

The backend status is logged at startup:

```
[MemoryMonitor] Native module loaded from: .../dist/native/memory_native.node
[MemoryMonitor] Native memory module loaded successfully
```

Or if falling back:

```
[MemoryMonitor] Native module not found, falling back to PowerShell/WMI
```

---

## 📖 More

- [Native Module Technical Details](./native/README.md) — How `QueryWorkingSetEx` works
- [Full API Reference & Architecture](../../README.md) — Complete SDK documentation
- [Design Document](../../MEMORY_PROFILING_DESIGN.md) — Architecture decisions
