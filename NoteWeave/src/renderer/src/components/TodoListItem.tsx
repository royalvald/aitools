import { CheckSquare, FileText, Square, StickyNote, Trash2, ArrowUpRight, Pencil } from 'lucide-react'
import { formatDate } from '../lib/utils'
import type { Todo } from '../types'

interface TodoListItemProps {
  todo: Todo
  /**
   * 关联对象的显示名称（文档名 / 便签标题）。
   * - hasTarget=false：无关联待办（targetId 为空）
   * - hasTarget=true 且 targetLabel=null：关联对象已被删除（关联失效）
   * - hasTarget=true 且 targetLabel=string：关联有效
   */
  hasTarget: boolean
  targetLabel: string | null
  onToggle: (todo: Todo) => void
  onEdit: (todo: Todo) => void
  onDelete: (id: string) => void
  onOpenTarget: (todo: Todo) => void
}

export function TodoListItem({
  todo,
  hasTarget,
  targetLabel,
  onToggle,
  onEdit,
  onDelete,
  onOpenTarget
}: TodoListItemProps) {
  const targetMissing = hasTarget && targetLabel === null
  const TargetIcon = todo.targetType === 'kbDoc' ? FileText : StickyNote
  const targetText = todo.targetType === 'kbDoc' ? '文档' : '笔记'

  return (
    <div className="group relative flex w-full items-start gap-3 rounded-lg border border-transparent bg-[var(--color-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)]">
      {/* 完成状态复选框 */}
      <button
        type="button"
        onClick={() => onToggle(todo)}
        className={`mt-0.5 flex-shrink-0 rounded p-0.5 transition-colors ${
          todo.done
            ? 'text-[var(--color-success)] hover:text-[var(--color-success)]'
            : 'text-[var(--color-muted-foreground)]/60 hover:text-[var(--color-warning)]'
        }`}
        title={todo.done ? '标记为未完成' : '标记为已完成'}
      >
        {todo.done ? <CheckSquare className="h-5 w-5" /> : <Square className="h-5 w-5" />}
      </button>

      {/* 主内容区 */}
      <div className="min-w-0 flex-1">
        <div
          className={`mb-1 break-words font-medium ${
            todo.done ? 'text-[var(--color-muted-foreground)] line-through' : 'text-[var(--color-foreground)]'
          }`}
        >
          {todo.title || '未命名待办'}
        </div>
        {todo.detail && (
          <p
            className={`mb-1 line-clamp-2 break-words text-sm ${
              todo.done ? 'text-[var(--color-muted-foreground)]/60' : 'text-[var(--color-muted-foreground)]'
            }`}
          >
            {todo.detail}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
          {!hasTarget ? (
            <span className="text-[var(--color-muted-foreground)]/60">无关联</span>
          ) : targetMissing ? (
            <span className="flex items-center gap-1 text-[var(--color-muted-foreground)]/60">
              <TargetIcon className="h-3 w-3" />
              关联已失效
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1">
              <TargetIcon className="h-3 w-3 flex-shrink-0" />
              <span className="text-[var(--color-muted-foreground)]">{targetText}：</span>
              <span className="truncate text-[var(--color-muted-foreground)]">{targetLabel}</span>
            </span>
          )}
          <span>{formatDate(todo.updatedAt)}</span>
        </div>
      </div>

      {/* 右侧操作按钮（hover 显示） */}
      <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(todo)}
          className="btn-icon"
          title="编辑"
        >
          <Pencil className="h-4 w-4" />
        </button>
        {hasTarget && !targetMissing && (
          <button
            type="button"
            onClick={() => onOpenTarget(todo)}
            className="rounded p-1 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-primary)]"
            title={`打开${targetText}`}
          >
            <ArrowUpRight className="h-4 w-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDelete(todo.id)}
          className="rounded p-1 text-[var(--color-muted-foreground)]/60 transition-colors hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
          title="删除"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
