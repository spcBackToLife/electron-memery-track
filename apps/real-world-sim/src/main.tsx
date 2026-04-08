import React, { useState, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom/client'

declare global {
  interface Window {
    simAPI: {
      startPush: () => Promise<void>
      stopPush: () => Promise<void>
      onData: (callback: (data: { seq: number; items: Item[] }) => void) => void
      removeDataListener: () => void
    }
  }
}

interface Item {
  id: string
  title: string
  content: string
  timestamp: number
}

// ===== 模拟路由：多个"页面" =====
type Page = 'home' | 'list' | 'detail' | 'settings'

// 首页
function HomePage() {
  return (
    <div style={{ padding: 24 }}>
      <h2>🏠 首页</h2>
      <p style={{ color: 'rgba(255,255,255,0.5)' }}>模拟真实业务的首页</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 16 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{
            background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 16,
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>📦</div>
            <h3>模块 {i + 1}</h3>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>业务功能模块描述</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// 列表页（大量数据）
function ListPage() {
  const [items, setItems] = useState<Item[]>([])
  const [isReceiving, setIsReceiving] = useState(false)

  useEffect(() => {
    window.simAPI?.onData((data) => {
      setItems((prev) => [...prev, ...data.items].slice(-500)) // 保留最近 500 条
    })
    return () => window.simAPI?.removeDataListener()
  }, [])

  const togglePush = async () => {
    if (isReceiving) {
      await window.simAPI?.stopPush()
    } else {
      await window.simAPI?.startPush()
    }
    setIsReceiving(!isReceiving)
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>📋 消息列表</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <button onClick={togglePush} style={{
          padding: '8px 16px', borderRadius: 6, border: 'none',
          background: isReceiving ? '#ff4d4f' : '#52c41a', color: 'white', cursor: 'pointer',
        }}>
          {isReceiving ? '⏹ 停止推送' : '▶ 开始推送'}
        </button>
        <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
          当前: {items.length} 条 (最多保留 500 条)
        </span>
        <button onClick={() => setItems([])} style={{
          padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)',
          background: 'transparent', color: '#e0e0e0', cursor: 'pointer', fontSize: 12,
        }}>清空</button>
      </div>
      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
        {items.map((item) => (
          <div key={item.id} style={{
            padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{item.title}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
              {item.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// 详情页（模拟大量内容）
function DetailPage() {
  const paragraphs = Array.from({ length: 20 }, (_, i) =>
    `这是第 ${i + 1} 段模拟的业务内容。` + '在真实应用中，这里会包含复杂的富文本、图片、表格等内容。'.repeat(3)
  )

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <h2>📄 详情页</h2>
      <p style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>模拟内容详情页</p>
      {paragraphs.map((p, i) => (
        <p key={i} style={{ marginBottom: 12, lineHeight: 1.6, fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>
          {p}
        </p>
      ))}
    </div>
  )
}

// 设置页
function SettingsPage() {
  const [settings, setSettings] = useState({
    notifications: true,
    autoUpdate: true,
    theme: 'dark',
    language: 'zh-CN',
  })

  return (
    <div style={{ padding: 24, maxWidth: 500 }}>
      <h2>⚙️ 设置</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {Object.entries(settings).map(([key, value]) => (
          <div key={key} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', background: 'rgba(255,255,255,0.05)', borderRadius: 8,
          }}>
            <span>{key}</span>
            <span style={{ color: '#61dafb' }}>{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// 弹窗
function Modal({ onClose }: { onClose: () => void }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: '#16213e', borderRadius: 12, padding: 24, width: 400,
        border: '1px solid rgba(255,255,255,0.1)',
      }} onClick={(e) => e.stopPropagation()}>
        <h3>📢 模拟弹窗</h3>
        <p style={{ color: 'rgba(255,255,255,0.5)', margin: '12px 0' }}>
          弹窗会创建额外的 DOM 层，测试其对内存的影响。
        </p>
        <button onClick={onClose} style={{
          padding: '8px 20px', borderRadius: 6, border: 'none',
          background: '#646cff', color: 'white', cursor: 'pointer',
        }}>关闭</button>
      </div>
    </div>
  )
}

function App() {
  const [page, setPage] = useState<Page>('home')
  const [showModal, setShowModal] = useState(false)

  const pages: { key: Page; label: string; icon: string }[] = [
    { key: 'home', label: '首页', icon: '🏠' },
    { key: 'list', label: '列表', icon: '📋' },
    { key: 'detail', label: '详情', icon: '📄' },
    { key: 'settings', label: '设置', icon: '⚙️' },
  ]

  return (
    <div style={{
      display: 'flex', height: '100vh', fontFamily: 'sans-serif',
      background: '#1a1a2e', color: '#e0e0e0',
    }}>
      {/* 侧边栏 */}
      <nav style={{
        width: 200, background: '#16213e', padding: '20px 0',
        borderRight: '1px solid rgba(255,255,255,0.1)',
        display: 'flex', flexDirection: 'column',
      }}>
        <h3 style={{ padding: '0 16px', marginBottom: 16, fontSize: 14 }}>🏢 模拟应用</h3>
        {pages.map((p) => (
          <button key={p.key} onClick={() => setPage(p.key)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px',
            border: 'none', background: page === p.key ? 'rgba(100,108,255,0.2)' : 'transparent',
            color: page === p.key ? '#646cff' : '#e0e0e0', cursor: 'pointer',
            fontSize: 13, textAlign: 'left', width: '100%',
          }}>
            <span>{p.icon}</span> {p.label}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        <button onClick={() => setShowModal(true)} style={{
          margin: '0 12px', padding: '8px 12px', borderRadius: 6,
          border: '1px solid rgba(255,255,255,0.2)', background: 'transparent',
          color: '#e0e0e0', cursor: 'pointer', fontSize: 12,
        }}>
          📢 打开弹窗
        </button>
      </nav>

      {/* 内容区 */}
      <main style={{ flex: 1, overflowY: 'auto' }}>
        {page === 'home' && <HomePage />}
        {page === 'list' && <ListPage />}
        {page === 'detail' && <DetailPage />}
        {page === 'settings' && <SettingsPage />}
      </main>

      {/* 弹窗 */}
      {showModal && <Modal onClose={() => setShowModal(false)} />}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
