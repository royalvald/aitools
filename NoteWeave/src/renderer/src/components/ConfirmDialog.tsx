import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from './Modal'

interface ConfirmOptions {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认按钮使用危险色。 */
  danger?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

interface PendingConfirm {
  options: ConfirmOptions
  resolve: (ok: boolean) => void
}

// 确认对话框（promise 式）：const confirm = useConfirm(); if (await confirm({...})) ...
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  // 连续触发多个确认时排队，避免丢失。
  const queueRef = useRef<PendingConfirm[]>([])

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      const item: PendingConfirm = { options, resolve }
      setPending((current) => {
        if (current) {
          queueRef.current.push(item)
          return current
        }
        return item
      })
    })
  }, [])

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    const next = queueRef.current.shift() ?? null
    setPending(next)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal title={pending.options.title} size="sm" onClose={() => settle(false)}>
          {pending.options.description && (
            <p className="whitespace-pre-line text-sm text-[var(--color-muted-foreground)]">
              {pending.options.description}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => settle(false)} className="btn-secondary">
              {pending.options.cancelText ?? '取消'}
            </button>
            <button
              onClick={() => settle(true)}
              className={pending.options.danger ? 'btn-danger' : 'btn-primary'}
            >
              {pending.options.confirmText ?? '确定'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm 必须在 <ConfirmDialogProvider> 内使用')
  }
  return ctx
}
