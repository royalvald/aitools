import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZE_MAX_WIDTH: Record<ModalSize, string> = {
  sm: 'min(24rem, calc(100vw - 2rem))',
  md: 'min(32rem, calc(100vw - 2rem))',
  lg: 'min(42rem, calc(100vw - 2rem))',
  xl: 'min(56rem, calc(100vw - 2rem))'
}

interface ModalProps {
  title: string
  children: ReactNode
  onClose: () => void
  /** 弹窗宽度档位，默认 md（保持原有 32rem 宽度）。 */
  size?: ModalSize
}

export function Modal({ title, children, onClose, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc 关闭 + 打开时焦点落入弹窗、关闭后还原焦点。
  useEffect(() => {
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    if (panel) {
      const focusable = panel.querySelector<HTMLElement>(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
      )
      ;(focusable ?? panel).focus()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 多层弹窗叠放时只关闭最顶层的一个。
      const dialogs = document.querySelectorAll('[role="dialog"]')
      const topmost = dialogs[dialogs.length - 1]
      if (topmost && panel && (topmost === panel || topmost.contains(panel))) {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousActive?.focus()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-foreground)]/40 p-4 backdrop-blur-sm dark:bg-[var(--color-foreground)]/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="surface-elevated flex w-full flex-col outline-none"
        style={{ maxWidth: SIZE_MAX_WIDTH[size], maxHeight: '80vh' }}
      >
        <div className="panel-header justify-between px-5 py-3.5">
          <h3 className="text-base font-semibold text-[var(--color-foreground)]">{title}</h3>
          <button
            onClick={onClose}
            className="btn-icon"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  )
}
