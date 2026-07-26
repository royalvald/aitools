import { useEffect, useRef } from 'react'
import { Copy, Eye, FolderOpen, Trash2 } from 'lucide-react'

interface ImageContextMenuProps {
  position: { x: number; y: number }
  imageUrl: string
  onClose: () => void
  /** 复制图片到剪贴板 */
  onCopy: (url: string) => void
  /** 用系统查看器打开原图 */
  onView: (url: string) => void
  /** 在系统文件夹中显示 */
  onShowInFolder: (url: string) => void
  /** 删除图片（删文件 + 清引用），由调用方实现 */
  onDelete: (url: string) => void
}

// REQ-004 图片右键菜单：复制 / 查看原图 / 在文件夹中显示 / 删除。
// 定位与点击外部/Esc 关闭参考 AnnotationContextMenu。
export function ImageContextMenu({
  position,
  imageUrl,
  onClose,
  onCopy,
  onView,
  onShowInFolder,
  onDelete
}: ImageContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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

  const left = Math.min(position.x, window.innerWidth - 200)
  const top = Math.min(position.y, window.innerHeight - 180)

  const items = [
    { label: '复制图片', icon: Copy, action: () => onCopy(imageUrl) },
    { label: '查看原图', icon: Eye, action: () => onView(imageUrl) },
    { label: '在文件夹中显示', icon: FolderOpen, action: () => onShowInFolder(imageUrl) },
    { label: '删除图片', icon: Trash2, action: () => onDelete(imageUrl), danger: true }
  ]

  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-50 min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
    >
      {items.map((it) => {
        const Icon = it.icon
        return (
          <button
            key={it.label}
            onClick={it.action}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--nw-ghost-hover)] ${
              it.danger
                ? 'text-[var(--color-danger)] hover:text-[var(--color-danger)]'
                : 'text-[var(--color-foreground)]'
            }`}
          >
            <Icon className="h-4 w-4" />
            {it.label}
          </button>
        )
      })}
    </div>
  )
}
