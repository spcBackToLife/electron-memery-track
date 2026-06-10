import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from '../hooks/useSession'
import { useToast } from '../context/ToastContext'

const DEFAULT_SCENARIO = 'scripts/scenarios/launcher-nav.scenario.json'

type RunPhase = 'idle' | 'running' | 'done' | 'error'

interface AutomationStatus {
  sessionRunning: boolean
  sessionLabel: string | null
  collecting: boolean
  externalMonitor: boolean
  batchRunning?: boolean
  batchPhase?: string | null
  batchMessage?: string | null
  batchRunIndex?: number
  batchTotalRuns?: number
  monitorReady?: boolean
  externalRootPid?: number | null
}

interface BatchProgress {
  phase: string
  message: string
  runIndex: number
  totalRuns: number
}

const BATCH_PHASE_LABELS: Record<string, string> = {
  init: '准备',
  'run-start': '轮次开始',
  cleanup: '清理',
  launch: '启动应用',
  'cdp-wait': '等待 CDP',
  warmup: '预热',
  scenario: '执行场景',
  'scenario-done': '场景结束',
  'session-end': '结束会话',
  kill: '关闭应用',
  'run-done': '本轮完成',
  'run-error': '本轮失败',
}

const AutomationPage: React.FC = () => {
  const { showToast } = useToast()
  const { refreshSessions } = useSession()

  const [appPath, setAppPath] = useState('')
  const [scenarioPath, setScenarioPath] = useState(DEFAULT_SCENARIO)
  const [scenarioJson, setScenarioJson] = useState('')
  const [savedJson, setSavedJson] = useState('')
  const [scenarioLoading, setScenarioLoading] = useState(false)
  const [sessionPrefix, setSessionPrefix] = useState('auto')
  const [stepDelayMs, setStepDelayMs] = useState(5000)
  const [repeats, setRepeats] = useState(3)
  const [playwrightSource, setPlaywrightSource] = useState('')
  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const [logLines, setLogLines] = useState<string[]>([])
  const [status, setStatus] = useState<AutomationStatus | null>(null)
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null)

  const dirty = scenarioJson !== savedJson

  const appendLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-60), line])
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const data = await window.monitorAPI.getAutomationStatus()
      setStatus(data)
    } catch { /* ignore */ }
  }, [])

  const loadScenario = useCallback(async (path: string, silent = false) => {
    const target = path.trim()
    if (!target) return
    setScenarioLoading(true)
    try {
      const r = await window.monitorAPI.readScenario(target)
      if (!r.ok || r.content == null) {
        if (!silent) showToast(r.error ?? '加载场景失败', 'error')
        return
      }
      setScenarioPath(r.scenarioPath ?? target)
      setScenarioJson(r.content)
      setSavedJson(r.content)
      if (!silent) showToast('场景已加载', 'success')
    } finally {
      setScenarioLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    void loadScenario(DEFAULT_SCENARIO, true)
  }, [loadScenario])

  useEffect(() => {
    void refreshStatus()
    const offProgress = window.monitorAPI.onAutomationProgress((p) => {
      setBatchProgress(p)
      appendLog(`[${p.runIndex}/${p.totalRuns}] ${p.phase}: ${p.message}`)
    })
    const offStatus = window.monitorAPI.onAutomationStatus((data) => {
      setStatus(data)
    })
    return () => {
      offProgress()
      offStatus()
    }
  }, [appendLog, refreshStatus])

  const pickApp = async () => {
    const r = await window.monitorAPI.pickExecutable()
    if (!r.canceled && r.path) setAppPath(r.path)
  }

  const pickScenario = async () => {
    const r = await window.monitorAPI.pickScenario()
    if (!r.canceled && r.path) {
      setScenarioPath(r.path)
      await loadScenario(r.path)
    }
  }

  const saveScenario = async (path = scenarioPath) => {
    const target = path.trim()
    if (!target) {
      showToast('请先填写场景路径', 'warning')
      return false
    }
    try {
      JSON.parse(scenarioJson)
    } catch {
      showToast('JSON 格式无效，请检查后再保存', 'error')
      return false
    }
    const r = await window.monitorAPI.writeScenario({ scenarioPath: target, content: scenarioJson })
    if (!r.ok) {
      showToast(r.error ?? '保存失败', 'error')
      return false
    }
    if (r.scenarioPath) setScenarioPath(r.scenarioPath)
    setSavedJson(scenarioJson)
    showToast('场景已保存', 'success')
    appendLog(`场景已保存: ${r.scenarioPath ?? target}`)
    return true
  }

  const saveScenarioAs = async () => {
    const r = await window.monitorAPI.saveScenarioAs('my.scenario.json')
    if (r.canceled || !r.path) return
    setScenarioPath(r.path)
    await saveScenario(r.path)
  }

  const convertPlaywright = async () => {
    if (!playwrightSource.trim()) {
      showToast('请先粘贴录制代码', 'warning')
      return
    }
    const r = await window.monitorAPI.convertPlaywright({ source: playwrightSource, stepDelayMs })
    if (!r.ok) {
      showToast(r.error ?? '转换失败', 'error')
      return
    }
    if (r.scenarioPath) {
      setScenarioPath(r.scenarioPath)
      if (r.content) {
        setScenarioJson(r.content)
        setSavedJson(r.content)
      } else {
        await loadScenario(r.scenarioPath, true)
      }
      showToast(`已生成新场景（${r.stepCount ?? 0} 步），可在下方直接编辑`, 'success')
      appendLog(`新场景: ${r.scenarioPath}`)
    }
  }

  const ensureScenarioSaved = async () => {
    if (!dirty) return true
    return saveScenario()
  }

  const runAutomation = async (rounds: number) => {
    if (!appPath.trim()) {
      showToast('请先选择应用 exe', 'warning')
      return
    }
    if (!scenarioJson.trim()) {
      showToast('场景 JSON 为空，请先加载或转换场景', 'warning')
      return
    }
    const saved = await ensureScenarioSaved()
    if (!saved) return

    setRunPhase('running')
    setLogLines([])
    setBatchProgress({ phase: 'init', message: '准备中…', runIndex: 0, totalRuns: rounds })
    appendLog(`开始 ${rounds === 1 ? '单轮' : `${rounds} 轮批量`}自动化…`)
    appendLog('说明：无需手动「开始记录」— 程序会自动启动应用、开会话、跑场景、落盘、关应用')

    try {
      const result = await window.monitorAPI.runAutomationBatch({
        appPath: appPath.trim(),
        scenarioPath,
        sessionPrefix: sessionPrefix.trim() || 'auto',
        repeats: rounds,
        stepDelayMs,
        warmupBeforeScenarioMs: 15_000,
        betweenRunsMs: 8_000,
        cdpPort: 9222,
      })

      await refreshSessions()
      await refreshStatus()

      if (result.ok) {
        setRunPhase('done')
        appendLog(`全部完成：${result.completed}/${rounds} 轮成功`)
        if (result.errors?.length) {
          result.errors.forEach((e) => appendLog(`⚠ ${e}`))
        }
        showToast(`自动化完成 ${result.completed}/${rounds} 轮，请到「测试报告」查看`, 'success')
      } else {
        setRunPhase('error')
        appendLog(`失败: ${result.error}`)
        showToast(result.error ?? '自动化失败', 'error')
      }
    } catch (e) {
      setRunPhase('error')
      appendLog(String(e))
      showToast('自动化执行异常', 'error')
    } finally {
      setBatchProgress(null)
    }
  }

  const busy = runPhase === 'running'
  const activeBatch = batchProgress ?? (status?.batchRunning ? {
    phase: status.batchPhase ?? 'running',
    message: status.batchMessage ?? '执行中…',
    runIndex: status.batchRunIndex ?? 0,
    totalRuns: status.batchTotalRuns ?? 0,
  } : null)

  const batchStepText = activeBatch
    ? `${BATCH_PHASE_LABELS[activeBatch.phase] ?? activeBatch.phase}`
      + (activeBatch.totalRuns > 0 ? ` · 第 ${activeBatch.runIndex}/${activeBatch.totalRuns} 轮` : '')
      + ` · ${activeBatch.message}`
    : null
  const stepCount = useMemo(() => {
    try {
      const parsed = JSON.parse(scenarioJson || '{}') as { steps?: unknown[] }
      return Array.isArray(parsed.steps) ? parsed.steps.length : 0
    } catch {
      return null
    }
  }, [scenarioJson])

  return (
    <div className="mmt-automation-page">
      <header className="mmt-automation-header">
        <h2>🤖 自动化测试</h2>
        <p className="section-desc">
          配置应用与场景脚本后，点下方按钮即可<strong>全自动</strong>完成一整轮测试。
          程序会代为：启动应用（带 CDP 9222）→ 自动开始监控会话 → 执行场景并打 mark → 结束会话生成报告 → 关闭应用。
          <strong>不需要</strong>去「实时监控」页手动附加或点「开始记录」。
        </p>
      </header>

      <div className="mmt-automation-steps">
        <section className="mmt-automation-step-card">
          <h3>① 选择被测应用</h3>
          <div className="mmt-automation-path-row">
            <input
              type="text"
              value={appPath}
              onChange={(e) => setAppPath(e.target.value)}
              placeholder="例如 C:\Games\launcher.exe"
              disabled={busy}
            />
            <button type="button" className="btn btn-secondary" onClick={pickApp} disabled={busy}>
              浏览…
            </button>
          </div>
          <p className="mmt-automation-hint">启动时会自动附加 <code>--remote-debugging-port=9222</code></p>
        </section>

        <section className="mmt-automation-step-card">
          <h3>② 场景脚本（可编辑 JSON）</h3>
          <div className="mmt-automation-path-row">
            <input
              type="text"
              value={scenarioPath}
              onChange={(e) => setScenarioPath(e.target.value)}
              placeholder="scripts/scenarios/xxx.scenario.json"
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => loadScenario(scenarioPath)}
              disabled={busy || scenarioLoading}
            >
              {scenarioLoading ? '加载中…' : '加载'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={pickScenario} disabled={busy}>
              浏览…
            </button>
          </div>

          <div className="mmt-automation-editor-toolbar">
            <span className="mmt-automation-editor-meta">
              {stepCount != null ? `${stepCount} 个步骤` : 'JSON 格式有误'}
              {dirty ? ' · 未保存' : ' · 已保存'}
            </span>
            <div className="mmt-automation-editor-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => saveScenario()}
                disabled={busy || !dirty}
              >
                保存
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={saveScenarioAs}
                disabled={busy}
              >
                另存为…
              </button>
            </div>
          </div>

          <textarea
            className="mmt-automation-json-editor"
            rows={16}
            value={scenarioJson}
            onChange={(e) => setScenarioJson(e.target.value)}
            spellCheck={false}
            disabled={busy}
            placeholder='{ "name": "...", "steps": [ ... ] }'
          />

          <details className="mmt-automation-convert">
            <summary>从 Playwright 录制代码生成场景 JSON</summary>
            <p className="mmt-automation-hint">
              转换会<strong>新建</strong>一个文件（如 <code>converted-20250609T120000.scenario.json</code>），
              并自动加载到上方编辑器，你可以直接改步骤、mark 名称后再点「保存」。
            </p>
            <textarea
              rows={8}
              value={playwrightSource}
              onChange={(e) => setPlaywrightSource(e.target.value)}
              placeholder="粘贴 await page.getByText('登录游戏').click(); ..."
              disabled={busy}
            />
            <button type="button" className="btn btn-secondary" onClick={convertPlaywright} disabled={busy}>
              转换为场景 JSON
            </button>
          </details>
        </section>

        <section className="mmt-automation-step-card">
          <h3>③ 参数</h3>
          <label className="mmt-automation-field-label">
            会话名前缀
            <input
              type="text"
              className="mmt-automation-full-input"
              value={sessionPrefix}
              onChange={(e) => setSessionPrefix(e.target.value)}
              placeholder="例如 auto、生涯流程、v1.2回归"
              disabled={busy}
            />
          </label>
          <p className="mmt-automation-hint">
            每轮会话名格式：<code>{'{前缀}'}-{'{应用名}'}-run{'{轮次}'}-{'{时间}'}</code>
            ，例如 <code>{sessionPrefix.trim() || 'auto'}-launcher-run1-2025-06-09-12-00-00</code>
          </p>
          <div className="mmt-automation-row-inline">
            <label>
              每步间隔 (ms)
              <input
                type="number"
                min={0}
                step={500}
                value={stepDelayMs}
                onChange={(e) => setStepDelayMs(Math.max(0, parseInt(e.target.value, 10) || 0))}
                disabled={busy}
              />
            </label>
            <label>
              批量重复次数
              <input
                type="number"
                min={1}
                max={20}
                value={repeats}
                onChange={(e) => setRepeats(Math.max(1, parseInt(e.target.value, 10) || 1))}
                disabled={busy}
              />
            </label>
          </div>
          <p className="mmt-automation-hint">
            「每步间隔」仅影响<strong>新转换</strong>的场景；已加载的 JSON 里 <code>wait</code> 步骤以文件内容为准。
          </p>
        </section>

        <section className="mmt-automation-step-card mmt-automation-step-run">
          <h3>④ 开始（自动开会话，无需手动操作）</h3>
          <div className="mmt-automation-run-buttons">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={busy || !appPath.trim()}
              onClick={() => runAutomation(1)}
            >
              {busy ? '执行中…' : '▶ 开始单轮测试'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !appPath.trim()}
              onClick={() => runAutomation(repeats)}
            >
              {busy ? '执行中…' : `🔁 批量执行 ${repeats} 轮`}
            </button>
          </div>
          <p className="mmt-automation-hint">
            若有未保存修改会先自动保存；执行期间可到「📊 实时监控」看曲线，完成后到「📋 测试报告」看带 mark 的报告。
          </p>
        </section>
      </div>

      <aside className="mmt-automation-sidebar">
        <h4>运行状态</h4>
        <ul className="mmt-automation-status-list">
          <li>
            <span>自动化流程</span>
            <strong className={busy ? 'mmt-status-active' : ''}>
              {busy || status?.batchRunning
                ? (batchStepText ?? '执行中…')
                : runPhase === 'done'
                  ? '已完成'
                  : runPhase === 'error'
                    ? '失败'
                    : '空闲'}
            </strong>
          </li>
          <li>
            <span>监控会话</span>
            <strong className={status?.sessionRunning ? 'mmt-status-active' : ''}>
              {status?.sessionRunning
                ? `进行中 · ${status.sessionLabel ?? ''}`
                : (busy || status?.batchRunning) && status?.sessionLabel
                  ? `未就绪 · 预期 ${status.sessionLabel}`
                  : (busy || status?.batchRunning)
                    ? '等待开会话…'
                    : '未开始'}
            </strong>
          </li>
          <li>
            <span>内存采集</span>
            <strong className={status?.collecting ? 'mmt-status-active' : ''}>
              {status?.collecting ? '采集中' : '已停止'}
            </strong>
          </li>
          <li>
            <span>外部进程</span>
            <strong className={status?.externalMonitor ? 'mmt-status-active' : ''}>
              {status?.externalMonitor
                ? `已附加 · PID ${status.externalRootPid ?? '?'}`
                : '无'}
            </strong>
          </li>
          {(busy || status?.batchRunning) && (
            <li>
              <span>监控就绪</span>
              <strong className={status?.monitorReady ? 'mmt-status-active' : ''}>
                {status?.monitorReady ? '是（会话+采集+附加）' : '否'}
              </strong>
            </li>
          )}
        </ul>
        {(busy || status?.batchRunning) && !status?.monitorReady
          && (status?.batchPhase === 'warmup' || status?.batchPhase === 'scenario' || status?.batchPhase === 'scenario-done') && (
          <p className="mmt-automation-hint">
            预热/场景阶段应已附加并采集中。若「监控就绪」为否，说明根 PID 可能仍不对；场景点击可继续，但 mark/内存曲线可能缺失。
          </p>
        )}

        {logLines.length > 0 ? (
          <>
            <h4>执行日志</h4>
            <pre className="mmt-automation-log">{logLines.join('\n')}</pre>
          </>
        ) : (
          <p className="mmt-automation-hint">日志将在点击「开始」后显示</p>
        )}
      </aside>
    </div>
  )
}

export default AutomationPage
