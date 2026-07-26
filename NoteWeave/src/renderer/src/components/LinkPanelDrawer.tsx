import { useState, type ReactNode } from 'react'
import { CheckSquare, ChevronDown, ChevronUp, Link2, Plus, Square, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { LinkPanel } from './LinkPanel'
import type { Todo } from '../types'

interface LinkItem {
  id: string
  title: string
  subtitle?: string
}

interface LinkPanelDrawerProps {
  /** 标题，如“关联与待办” */
  title: string
  items: LinkItem[]
  emptyText: string
  addLabel: string
  onAdd: () => void
  onUnlink: (id: string) => void
  onItemClick?: (id: string) => void
  onCreate?: () => void
  createLabel?: string
  /** 主列表区块标题（默认与抽屉标题一致）；合并区块时可传「关联小记」 */
  sectionTitle?: string
  /** 展开时最大占据视口高度比例，默认 40vh */
  maxHeightClass?: string
  /** 第二区块（如「被提及」）：只读列表，渲染在主列表下方 */
  secondarySection?: {
    title: string
    items: LinkItem[]
    onItemClick?: (id: string) => void
  }
  /** 待办区块：勾选/删除/新建 */
  todoSection?: {
    todos: Todo[]
    onToggle: (todo: Todo) => void
    onDelete: (id: string) => void
    onCreate: () => void
  }
  /** 自定义额外内容（预留） */
  children?: ReactNode
}

/**
 * 底部可折叠抽屉：收起时只渲染一行标题栏 + 计数徽标，
 * 展开时渲染关联列表（+ 可选的被提及区块 + 待办区块）。
 * 所有区块内容均为空时不允许展开（无可看内容）。
 */
export function LinkPanelDrawer({
  title,
  items,
  emptyText,
  addLabel,
  onAdd,
  onUnlink,
  onItemClick,
  onCreate,
  createLabel,
  sectionTitle,
  maxHeightClass = 'max-h-[40vh]',
  secondarySection,
  todoSection
}: LinkPanelDrawerProps) {
  const [open, setOpen] = useState(false)
  const secondaryCount = secondarySection?.items.length ?? 0
  const todoCount = todoSection?.todos.length ?? 0
  const total = items.length + secondaryCount + todoCount
  const isEmpty = total === 0

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-surface-2">
      <button
        onClick={() => !isEmpty && setOpen((v) => !v)}
        disabled={isEmpty}
        title={isEmpty ? '暂无内容' : undefined}
        className={cn(
          'flex w-full items-center justify-between gap-2 px-6 py-2.5 text-left transition-colors',
          isEmpty ? 'cursor-default opacity-60' : 'hover:bg-[var(--color-foreground)]/[0.03]'
        )}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
          <Link2 className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          <span className="truncate">{title}</span>
          <span className="flex-shrink-0 rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-muted-foreground)]">
            {total}
          </span>
        </div>
        {!isEmpty &&
          (open ? (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          ) : (
            <ChevronUp className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          ))}
      </button>

      {open && !isEmpty && (
        <div className={`overflow-y-auto ${maxHeightClass} px-6 pb-4`}>
          <LinkPanel
            title={sectionTitle ?? title}
            emptyText={emptyText}
            addLabel={addLabel}
            items={items}
            onAdd={onAdd}
            onUnlink={onUnlink}
            onItemClick={onItemClick}
            onCreate={onCreate}
            createLabel={createLabel}
          />
          {secondarySection && secondarySection.items.length > 0 && (
            <div className="mt-4">
              <div className="mb-1.5 text-xs font-medium text-[var(--color-muted-foreground)]">
                {secondarySection.title}
                <span className="ml-1.5 rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px]">
                  {secondarySection.items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {secondarySection.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => secondarySection.onItemClick?.(item.id)}
                    className="rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--color-ghost-hover)]"
                  >
                    <div className="truncate text-sm font-medium text-[var(--color-foreground)]">
                      {item.title}
                    </div>
                    {item.subtitle && (
                      <div className="truncate text-[11px] text-[var(--color-muted-foreground)]">
                        {item.subtitle}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {todoSection && (
            <div className="mt-4">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="text-xs font-medium text-[var(--color-muted-foreground)]">
                  待办任务
                  <span className="ml-1.5 rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px]">
                    {todoSection.todos.length}
                  </span>
                </div>
                <button
                  onClick={todoSection.onCreate}
                  className="flex items-center gap-1 text-[11px] text-[var(--nw-primary)] hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  新建待办
                </button>
              </div>
              {todoSection.todos.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {todoSection.todos.map((todo) => (
                    <div
                      key={todo.id}
                      className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-ghost-hover)]"
                    >
                      <button
                        type="button"
                        onClick={() => todoSection.onToggle(todo)}
                        className={cn(
                          'mt-0.5 flex-shrink-0 transition-colors',
                          todo.done
                            ? 'text-[var(--color-success)]'
                            : 'text-[var(--color-muted-foreground)]/60 hover:text-[var(--nw-primary)]'
                        )}
                        title={todo.done ? '标记为未完成' : '标记为已完成'}
                      >
                        {todo.done ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            'break-words text-sm',
                            todo.done
                              ? 'text-[var(--color-muted-foreground)] line-through'
                              : 'text-[var(--color-foreground)]'
                          )}
                        >
                          {todo.title || '未命名待办'}
                        </div>
                        {todo.detail && (
                          <div className="break-words text-[11px] text-[var(--color-muted-foreground)]">
                            {todo.detail}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => todoSection.onDelete(todo.id)}
                        className="flex-shrink-0 rounded p-1 text-[var(--color-muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
