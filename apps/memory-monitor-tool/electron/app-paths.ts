/**
 * 开发 / 打包后统一解析场景 JSON、脚本目录路径。
 * - 内置场景：extraResources → resources/monitor-tool/scripts/scenarios
 * - 用户场景：userData/scenarios（可读写）
 */
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

let electronDir = ''

export function initMonitorPaths(dirnameElectron: string): void {
  electronDir = dirnameElectron
}

function assertInit(): void {
  if (!electronDir) throw new Error('initMonitorPaths 未调用')
}

/** 内置脚本根目录（scenario-runner.mjs 等） */
export function getBundledAppRoot(): string {
  assertInit()
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'monitor-tool')
  }
  return path.join(electronDir, '..')
}

export function getUserScenariosDir(): string {
  return path.join(app.getPath('userData'), 'scenarios')
}

export function getWritableScenariosDir(): string {
  const dir = getUserScenariosDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 首次启动：把内置示例场景复制到 userData（不覆盖用户已有文件） */
export function ensureBundledScenariosSeeded(): void {
  const bundled = path.join(getBundledAppRoot(), 'scripts', 'scenarios')
  const userDir = getWritableScenariosDir()
  if (!fs.existsSync(bundled)) return
  for (const name of fs.readdirSync(bundled)) {
    if (!name.endsWith('.json')) continue
    const dest = path.join(userDir, name)
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(path.join(bundled, name), dest)
    }
  }
}

function normalizeScenarioRel(scenarioPath: string): string {
  let rel = String(scenarioPath ?? '').trim().replace(/\\/g, '/')
  if (rel.startsWith('scripts/scenarios/')) rel = rel.slice('scripts/scenarios/'.length)
  if (rel.startsWith('scenarios/')) rel = rel.slice('scenarios/'.length)
  return rel
}

export function resolveBundledScenarioPath(scenarioPath: string): string {
  const raw = String(scenarioPath ?? '').trim()
  if (!raw) throw new Error('场景路径为空')
  if (path.isAbsolute(raw)) {
    const relBundled = path.relative(path.join(getBundledAppRoot(), 'scripts', 'scenarios'), raw)
    if (!relBundled.startsWith('..') && !path.isAbsolute(relBundled)) {
      return raw
    }
    throw new Error('仅支持覆盖内置 scenarios 目录下的场景')
  }
  return path.join(getBundledAppRoot(), 'scripts', 'scenarios', normalizeScenarioRel(raw))
}

export function resolveUserScenarioPath(scenarioPath: string): string {
  const raw = String(scenarioPath ?? '').trim()
  if (!raw) throw new Error('场景路径为空')
  if (path.isAbsolute(raw)) return raw
  return path.join(getWritableScenariosDir(), normalizeScenarioRel(raw))
}

export type ScenarioResolveSource = 'userData' | 'bundled' | 'absolute'

export function describeScenarioResolve(scenarioPath: string): {
  resolvedPath: string
  source: ScenarioResolveSource
  userDataPath: string
  bundledPath: string
  userDataExists: boolean
  bundledExists: boolean
} {
  const raw = String(scenarioPath ?? '').trim()
  if (!raw) throw new Error('场景路径为空')
  if (path.isAbsolute(raw)) {
    return {
      resolvedPath: raw,
      source: 'absolute',
      userDataPath: raw,
      bundledPath: raw,
      userDataExists: fs.existsSync(raw),
      bundledExists: false,
    }
  }
  const rel = normalizeScenarioRel(raw)
  const userDataPath = path.join(getUserScenariosDir(), rel)
  const bundledPath = path.join(getBundledAppRoot(), 'scripts', 'scenarios', rel)
  const userDataExists = fs.existsSync(userDataPath)
  const bundledExists = fs.existsSync(bundledPath)
  let resolvedPath = userDataPath
  let source: ScenarioResolveSource = 'userData'
  if (userDataExists) {
    resolvedPath = userDataPath
    source = 'userData'
  } else if (bundledExists) {
    resolvedPath = bundledPath
    source = 'bundled'
  }
  return { resolvedPath, source, userDataPath, bundledPath, userDataExists, bundledExists }
}

export function resolveScenarioPath(scenarioPath: string): string {
  const raw = String(scenarioPath ?? '').trim()
  if (!raw) throw new Error('场景路径为空')
  if (path.isAbsolute(raw)) return raw

  const { resolvedPath, userDataExists, bundledExists } = describeScenarioResolve(raw)
  if (userDataExists || bundledExists) return resolvedPath

  const legacy = path.resolve(getBundledAppRoot(), raw)
  if (fs.existsSync(legacy)) return legacy

  return resolveUserScenarioPath(raw)
}

/** 用仓库/内置 scripts/scenarios 覆盖 AppData 缓存（不删用户自建场景） */
export function overwriteUserScenarioFromBundled(scenarioPath: string): {
  ok: boolean
  scenarioPath?: string
  content?: string
  error?: string
} {
  try {
    const bundledPath = resolveBundledScenarioPath(scenarioPath)
    if (!fs.existsSync(bundledPath)) {
      return { ok: false, error: `仓库场景不存在: ${bundledPath}` }
    }
    const content = fs.readFileSync(bundledPath, 'utf-8')
    JSON.parse(content)
    const dest = resolveUserScenarioPath(scenarioPath)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(bundledPath, dest)
    return {
      ok: true,
      scenarioPath: toScenarioDisplayPath(dest),
      content,
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 覆盖 AppData 下所有与内置目录同名的 .json 场景 */
export function overwriteAllBundledScenariosToUser(): { copied: string[]; errors: string[] } {
  const bundledDir = path.join(getBundledAppRoot(), 'scripts', 'scenarios')
  const copied: string[] = []
  const errors: string[] = []
  if (!fs.existsSync(bundledDir)) {
    return { copied, errors: ['内置场景目录不存在'] }
  }
  const userDir = getWritableScenariosDir()
  for (const name of fs.readdirSync(bundledDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const src = path.join(bundledDir, name)
      const dest = path.join(userDir, name)
      fs.copyFileSync(src, dest)
      copied.push(name)
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { copied, errors }
}

export function resolveWritableScenarioPath(scenarioPath: string): string {
  const raw = String(scenarioPath ?? '').trim()
  if (!raw) throw new Error('场景路径为空')
  if (path.isAbsolute(raw)) return raw
  return path.join(getWritableScenariosDir(), normalizeScenarioRel(raw))
}

export function toScenarioDisplayPath(absPath: string): string {
  const userDir = getUserScenariosDir()
  const relUser = path.relative(userDir, absPath)
  if (!relUser.startsWith('..') && !path.isAbsolute(relUser)) {
    return `scenarios/${relUser}`.split(path.sep).join('/')
  }
  const relBundled = path.relative(getBundledAppRoot(), absPath)
  if (!relBundled.startsWith('..') && !path.isAbsolute(relBundled)) {
    return relBundled.split(path.sep).join('/')
  }
  return absPath
}

/** scenario-runner 从 scripts/ 向上解析 node_modules，打包后需在 monitor-tool/node_modules */
export function getScenarioRunnerNodeModulesPath(): string {
  return path.join(getBundledAppRoot(), 'node_modules')
}

export function getBundledScriptPath(...segments: string[]): string {
  return path.join(getBundledAppRoot(), 'scripts', ...segments)
}

/** 子进程跑 scenario-runner.mjs；playwright-core 在 monitor-tool/node_modules */
export function buildScenarioRunnerEnv(cdpPort: number, mmtPort = 39271): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_') || key.startsWith('ELECTRON_RENDERER_')) {
      delete env[key]
    }
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  env.CDP_URL = `http://127.0.0.1:${cdpPort}`
  env.MMT_API_URL = `http://127.0.0.1:${mmtPort}`
  env.MMT_SESSION_WAIT_MS = '60000'
  return env
}
