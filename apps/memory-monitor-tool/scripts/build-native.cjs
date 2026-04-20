/**
 * Windows：在 apps/memory-monitor-tool/native 下用 node-gyp 按 Electron ABI 编译，
 * 并将 memory_native.node 复制到 native/memory_native.node（与 native-memory 搜索路径一致）。
 * 非 Windows 直接退出 0，便于在 CI / 其他平台只跑 Vite 构建。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const nativeDir = path.join(root, 'native')
const ELECTRON_TARGET = '33.2.1'

if (process.platform !== 'win32') {
  console.log('[build-native] 非 Windows，跳过原生模块')
  process.exit(0)
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    process.exit(r.status ?? 1)
  }
}

run('npm', ['install', '--ignore-scripts'], nativeDir)
run(
  'npx',
  [
    'node-gyp',
    'rebuild',
    `--target=${ELECTRON_TARGET}`,
    '--arch=x64',
    '--dist-url=https://electronjs.org/headers',
  ],
  nativeDir,
)

const releaseNode = path.join(nativeDir, 'build', 'Release', 'memory_native.node')
const copyTo = path.join(nativeDir, 'memory_native.node')
if (!fs.existsSync(releaseNode)) {
  console.error('[build-native] 未找到编译产物:', releaseNode)
  process.exit(1)
}
fs.copyFileSync(releaseNode, copyTo)
console.log('[build-native] 已复制:', copyTo)
