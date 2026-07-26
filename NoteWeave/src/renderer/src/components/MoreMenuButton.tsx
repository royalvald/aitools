import { useEffect, useRef, useState } from 'react'
import { BookOpen, FolderPlus, ImageIcon, ListTodo, MoreHorizontal, Settings, Trash2 } from 'lucide-react'

interface MoreMenuButtonProps {
  /** 新建一级分组 */
  onCreateGroup?: () => void
  /** 进入知识库视图 */
  onEnterKnowledgeBase?: () => void
  /** 进入待办视图 */
  onEnterTodos?: () => void
  /** 打开回收站（REQ-013） */
  onOpenTrash?: () => void
  /** 打开资源管理（REQ-004） */
  onOpenAssets?: () => void
  /** 打开设置（REQ-111 等） */
  onOpenSettings?: () => void
  /** 折叠态：仅图标（默认 true） */
  withLabel?: boolean
}

/**
 * 侧栏头部「更多」入口：把低频功能（新建分组 / 知识库 / 待办任务 / 资源管理 / 回收站）收进下拉菜单，
 * 默认只占用一个按钮的位置，需要时点开才展开，避免头部拥挤、把高频的「新建」挤出。
 */
export function MoreMenuButton({
  onCreateGroup,
  onEnterKnowledgeBase,
  onEnterTodos,
  onOpenTrash,
  onOpenAssets,
  onOpenSettings,
  withLabel = true
}: MoreMenuButtonProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const items: { label: string; icon: typeof BookOpen; onClick?: () => void; visible: boolean }[] = [
    { label: '新建分组', icon: FolderPlus, onClick: onCreateGroup, visible: !!onCreateGroup },
    { label: '知识库', icon: BookOpen, onClick: onEnterKnowledgeBase, visible: !!onEnterKnowledgeBase },
    { label: '待办任务', icon: ListTodo, onClick: onEnterTodos, visible: !!onEnterTodos },
    { label: '资源管理', icon: ImageIcon, onClick: onOpenAssets, visible: !!onOpenAssets },
    { label: '设置', icon: Settings, onClick: onOpenSettings, visible: !!onOpenSettings },
    { label: '回收站', icon: Trash2, onClick: onOpenTrash, visible: !!onOpenTrash }
  ]
  const visibleItems = items.filter((i) => i.visible)

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={withLabel ? 'btn-ghost' : 'btn-icon'}
        title="更多功能"
      >
        <MoreHorizontal className="h-4 w-4" />
        {withLabel && <span>更多</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-40 overflow-hidden rounded-lg border border-[var(--color-border)] bg-surface py-1 text-sm shadow-[var(--shadow-md)]">
          {visibleItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.label}
                onClick={() => {
                  setOpen(false)
                  item.onClick?.()
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
              >
                <Icon className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
