import React from 'react'
import ReactDOM from 'react-dom/client'

function App() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif',
      background: '#1a1a2e', color: '#e0e0e0',
    }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '16px' }}>📊 Single Window</h1>
      <p style={{ color: 'rgba(255,255,255,0.5)' }}>空白 React 页面 — 内存基线测试场景</p>
      <p style={{ color: 'rgba(255,255,255,0.3)', marginTop: '8px', fontSize: '0.9rem' }}>
        监控面板已自动打开，请查看内存数据
      </p>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
