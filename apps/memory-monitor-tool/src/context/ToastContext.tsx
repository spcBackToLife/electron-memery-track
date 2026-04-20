/**
 * Toast 通知上下文
 */
import React, { createContext, useContext, useState, useCallback } from 'react'

interface ToastMessage {
  id: number
  text: string
  type: 'success' | 'error' | 'info' | 'warning'
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastMessage['type']) => void
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} })

let toastIdCounter = 0

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const showToast = useCallback((message: string, type: ToastMessage['type'] = 'info') => {
    const id = ++toastIdCounter
    setToasts((prev) => [...prev, { id, text: message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4000)
  }, [])

  const removeToast = (id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="mmt-toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`mmt-toast mmt-toast-${toast.type}`} onClick={() => removeToast(toast.id)}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = (): ToastContextValue => useContext(ToastContext)
