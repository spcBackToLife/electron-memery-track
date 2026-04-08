import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'

declare global {
  interface Window {
    ipcStressAPI: {
      startPush: (config: { interval: number; dataSize: number }) => Promise<unknown>
      stopPush: () => Promise<unknown>
      echo: (data: unknown) => Promise<unknown>
      onData: (callback: (data: unknown) => void) => void
      removeDataListener: () => void
    }
  }
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(100, 108, 255, 0.2)', color: '#e0e0e0', cursor: 'pointer', fontSize: 13,
}

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle, background: '#646cff',
}

function App() {
  const [isPushing, setIsPushing] = useState(false)
  const [interval, setInterval_] = useState(100) // ms
  const [dataSize, setDataSize] = useState(1024) // bytes
  const [receivedCount, setReceivedCount] = useState(0)
  const [echoRunning, setEchoRunning] = useState(false)
  const [echoRps, setEchoRps] = useState(0)
  const echoTimerRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    window.ipcStressAPI?.onData(() => {
      setReceivedCount((c) => c + 1)
    })
    return () => {
      window.ipcStressAPI?.removeDataListener()
    }
  }, [])

  const startPush = async () => {
    await window.ipcStressAPI?.startPush({ interval, dataSize })
    setIsPushing(true)
    setReceivedCount(0)
  }

  const stopPush = async () => {
    await window.ipcStressAPI?.stopPush()
    setIsPushing(false)
  }

  const startEcho = () => {
    if (echoTimerRef.current) clearInterval(echoTimerRef.current)
    let count = 0
    const startTime = Date.now()
    const data = 'A'.repeat(dataSize)

    echoTimerRef.current = setInterval(async () => {
      await window.ipcStressAPI?.echo(data)
      count++
      const elapsed = (Date.now() - startTime) / 1000
      setEchoRps(Math.round(count / elapsed))
    }, 1)

    setEchoRunning(true)
  }

  const stopEcho = () => {
    if (echoTimerRef.current) clearInterval(echoTimerRef.current)
    setEchoRunning(false)
  }

  return (
    <div style={{
      padding: 24, fontFamily: 'sans-serif', background: '#1a1a2e',
      color: '#e0e0e0', minHeight: '100vh',
    }}>
      <h1>📡 IPC 压力测试</h1>
      <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 24 }}>
        测试不同频率、不同数据量的 IPC 通信对内存的影响
      </p>

      {/* 配置区 */}
      <section style={{ marginBottom: 24 }}>
        <h2>⚙️ 参数配置</h2>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
              推送间隔 (ms)
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[10, 50, 100, 500, 1000].map((v) => (
                <button key={v} onClick={() => setInterval_(v)}
                  style={interval === v ? activeBtnStyle : btnStyle}>{v}ms</button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
              数据大小 (bytes)
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              {[1024, 10240, 102400, 1048576].map((v) => (
                <button key={v} onClick={() => setDataSize(v)}
                  style={dataSize === v ? activeBtnStyle : btnStyle}>
                  {v >= 1048576 ? `${v / 1048576}MB` : v >= 1024 ? `${v / 1024}KB` : `${v}B`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 主进程 → 渲染进程推送 */}
      <section style={{ marginBottom: 24 }}>
        <h2>⬇️ 主进程 → 渲染进程推送</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!isPushing ? (
            <button onClick={startPush} style={{ ...btnStyle, background: '#52c41a' }}>▶ 开始推送</button>
          ) : (
            <button onClick={stopPush} style={{ ...btnStyle, background: '#ff4d4f' }}>⏹ 停止</button>
          )}
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
            已接收: <strong style={{ color: '#61dafb' }}>{receivedCount.toLocaleString()}</strong> 条
            (每条 {dataSize >= 1024 ? `${dataSize / 1024}KB` : `${dataSize}B`})
          </span>
        </div>
      </section>

      {/* 渲染进程 → 主进程 Echo */}
      <section style={{ marginBottom: 24 }}>
        <h2>🔄 渲染进程 → 主进程 Echo</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!echoRunning ? (
            <button onClick={startEcho} style={{ ...btnStyle, background: '#52c41a' }}>▶ 开始</button>
          ) : (
            <button onClick={stopEcho} style={{ ...btnStyle, background: '#ff4d4f' }}>⏹ 停止</button>
          )}
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
            吞吐量: <strong style={{ color: '#f5a623' }}>{echoRps.toLocaleString()}</strong> req/s
          </span>
        </div>
      </section>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
