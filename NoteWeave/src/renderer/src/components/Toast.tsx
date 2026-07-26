import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '../lib/utils'

export type ToastType = 'success' | 'danger' | 'info'

interface ToastItem {
  id: number
  type: ToastType
  message: string
}

interface ToastApi {
  success: (message: string) => void
  danger: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const AUTO_DISMISS_MS = 3000

const TYPE_STYLE: Record<ToastType, { badge: string; Icon: typeof Info }> = {
  success: { badge: 'badge-success', Icon: CheckCircle2 },
  danger: { badge: 'badge-danger', Icon: XCircle },
  info: { badge: 'badge-primary', Icon: Info }
}

// 统一反馈体系：右下角非模态 toast，自动消失，可手动关闭。
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextIdRef = useRef(1)
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (type: ToastType, message: string) => {
      const id = nextIdRef.current++
      setToasts((prev) => [...prev, { id, type, message }])
      timersRef.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS))
    },
    [dismiss]
  )

  const api: ToastApi = {
    success: (message) => push('success', message),
    danger: (message) => push('danger', message),
    info: (message) => push('info', message)
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col items-stretch gap-2">
        {toasts.map((t) => {
          const { badge, Icon } = TYPE_STYLE[t.type]
          return (
            <div
              key={t.id}
              role="status"
              className="surface-elevated pointer-events-auto flex items-center gap-2.5 px-3.5 py-2.5 shadow-[var(--shadow-md)]"
            >
              <span className={cn('badge flex-shrink-0', badge)}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-[var(--color-foreground)]">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="btn-icon flex-shrink-0"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用')
  }
  return ctx
}
