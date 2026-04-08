import React, { useState, useEffect, useRef } from 'react'
import ReactDOM from 'react-dom/client'

/** DOM 压力测试：创建大量 DOM 节点 */
function DomStress({ count }: { count: number }) {
  return (
    <div className="dom-stress">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{
          display: 'inline-block', width: 8, height: 8, margin: 1,
          backgroundColor: `hsl(${(i * 37) % 360}, 70%, 60%)`,
          borderRadius: 2,
        }} />
      ))}
    </div>
  )
}

/** Canvas 压力测试：动画粒子 */
function CanvasStress({ particleCount }: { particleCount: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    canvas.width = 600
    canvas.height = 400

    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 2,
      vy: (Math.random() - 0.5) * 2,
      r: Math.random() * 4 + 1,
      color: `hsl(${Math.random() * 360}, 70%, 60%)`,
    }))

    const animate = () => {
      ctx.fillStyle = 'rgba(26, 26, 46, 0.1)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = p.color
        ctx.fill()
      }

      rafRef.current = requestAnimationFrame(animate)
    }

    animate()
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [particleCount])

  return <canvas ref={canvasRef} style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
}

/** Timer 压力测试：大量定时器 */
function TimerStress({ timerCount }: { timerCount: number }) {
  const [activeTimers, setActiveTimers] = useState(0)
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([])

  const startTimers = () => {
    stopTimers()
    for (let i = 0; i < timerCount; i++) {
      const timer = setInterval(() => {
        // 模拟定时器中的轻量工作
        const _ = Math.random() * Math.random()
      }, 100 + Math.random() * 900)
      timersRef.current.push(timer)
    }
    setActiveTimers(timerCount)
  }

  const stopTimers = () => {
    timersRef.current.forEach(clearInterval)
    timersRef.current = []
    setActiveTimers(0)
  }

  useEffect(() => () => stopTimers(), [])

  return (
    <div>
      <p>活跃定时器: <strong>{activeTimers}</strong></p>
      <button onClick={startTimers} style={btnStyle}>启动 {timerCount} 个定时器</button>
      <button onClick={stopTimers} style={{ ...btnStyle, marginLeft: 8 }}>停止</button>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(100, 108, 255, 0.2)', color: '#e0e0e0', cursor: 'pointer',
  fontSize: 13, marginTop: 8,
}

function App() {
  const [domCount, setDomCount] = useState(1000)
  const [particleCount, setParticleCount] = useState(200)
  const [showDom, setShowDom] = useState(false)
  const [showCanvas, setShowCanvas] = useState(false)
  const [showTimers, setShowTimers] = useState(false)

  return (
    <div style={{
      padding: 24, fontFamily: 'sans-serif', background: '#1a1a2e',
      color: '#e0e0e0', minHeight: '100vh',
    }}>
      <h1>🔥 重渲染压力测试</h1>
      <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 24 }}>
        控制不同类型的渲染压力，观察内存变化
      </p>

      {/* DOM 压力 */}
      <section style={{ marginBottom: 24 }}>
        <h2>📦 DOM 节点压力</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <span>数量：</span>
          {[1000, 5000, 10000, 20000].map((n) => (
            <button key={n} onClick={() => setDomCount(n)} style={{
              ...btnStyle, background: domCount === n ? '#646cff' : undefined,
            }}>{n.toLocaleString()}</button>
          ))}
          <button onClick={() => setShowDom(!showDom)} style={btnStyle}>
            {showDom ? '隐藏' : '显示'}
          </button>
        </div>
        {showDom && <DomStress count={domCount} />}
      </section>

      {/* Canvas 压力 */}
      <section style={{ marginBottom: 24 }}>
        <h2>🎨 Canvas 动画压力</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <span>粒子数：</span>
          {[200, 1000, 5000, 10000].map((n) => (
            <button key={n} onClick={() => setParticleCount(n)} style={{
              ...btnStyle, background: particleCount === n ? '#646cff' : undefined,
            }}>{n.toLocaleString()}</button>
          ))}
          <button onClick={() => setShowCanvas(!showCanvas)} style={btnStyle}>
            {showCanvas ? '隐藏' : '显示'}
          </button>
        </div>
        {showCanvas && <CanvasStress particleCount={particleCount} />}
      </section>

      {/* Timer 压力 */}
      <section style={{ marginBottom: 24 }}>
        <h2>⏱️ 定时器压力</h2>
        <button onClick={() => setShowTimers(!showTimers)} style={btnStyle}>
          {showTimers ? '隐藏' : '显示'}
        </button>
        {showTimers && <TimerStress timerCount={100} />}
      </section>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
