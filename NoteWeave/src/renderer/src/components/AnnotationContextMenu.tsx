import { useEffect, useRef } from 'react'
import { MessageSquarePlus, Pencil } from 'lucide-react'

export interface AnnotationContextMenuProps {
  position: { x: number; y: number }
  /** 'add' = 可添加；'edit' = 命中已有批注，进入编辑；'disabled' = 选区无效 */
  mode: 'add' | 'edit' | 'disabled'
  reason?: string
  onAdd: () => void
  onEdit: () => void
  onClose: () => void
}

/**
 * 右键浮动的批注操作菜单。
 * 位置跟随鼠标，点击外部或按 Esc 关闭。
 */
export function AnnotationContextMenu({ position, mode, reason, onAdd, onEdit, onClose }: AnnotationContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  // 防止菜单超出视口边界
  const left = Math.min(position.x, window.innerWidth - 200)
  const top = Math.min(position.y, window.innerHeight - 140)

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-sm shadow-lg"
      style={{ left, top }}
    >
      {mode === 'disabled' ? (
        <div className="px-3 py-2 text-[var(--color-muted-foreground)]">{reason || '无法添加批注'}</div>
      ) : mode === 'edit' ? (
        <button
          onClick={onEdit}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <Pencil className="h-4 w-4" />
          编辑批注
        </button>
      ) : (
        <button
          onClick={onAdd}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface-2)]"
        >
          <MessageSquarePlus className="h-4 w-4" />
          添加批注
        </button>
      )}
      <button
        onClick={onClose}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-surface-2)]"
      >
        取消
      </button>
    </div>
  )
}
