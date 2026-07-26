import { useState } from 'react'
import { CheckSquare, ChevronDown, ChevronUp, ListTodo, Plus, Square, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { formatDate } from '../lib/utils'
import type { Todo } from '../types'

interface TodoPanelProps {
  /** 隶属于当前笔记 / 文档的待办列表（由父组件通过 useTodosForTarget 提供） */
  todos: Todo[]
  /** 切换某条待办的完成状态 */
  onToggle: (todo: Todo) => void
  /** 删除某条待办 */
  onDelete: (id: string) => void
  /** 打开「新建待办」对话框（关联已锁定为当前对象） */
  onCreate: () => void
  /** 展开时最大占据视口高度比例，默认 40vh */
  maxHeightClass?: string
}

/**
 * 笔记 / 文档详情页底部的「待办任务」抽屉。
 *
 * 仿照 LinkPanelDrawer 的折叠抽屉样式：收起时只显示标题栏 + 待办计数徽标，
 * 展开时渲染隶属当前对象的待办列表，支持就地勾选完成 / 删除，并提供「新建待办」入口。
 * 这样既不挤占主体滚动区，又能直观看到「该对象下都有哪些待办」。
 */
export function TodoPanel({
  todos,
  onToggle,
  onDelete,
  onCreate,
  maxHeightClass = 'max-h-[40vh]'
}: TodoPanelProps) {
  const [open, setOpen] = useState(false)
  const pendingCount = todos.filter((t) => !t.done).length

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-surface-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-6 py-2.5 text-left transition-colors hover:bg-[var(--color-foreground)]/[0.03]"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
          <ListTodo className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          <span className="truncate">待办任务</span>
          <span
            title={`共 ${todos.length} 条，其中未完成 ${pendingCount} 条，已完成 ${todos.length - pendingCount} 条`}
            className="flex-shrink-0 rounded-full bg-[var(--color-border-strong)]/80 px-2 py-0.5 text-xs font-medium text-[var(--color-muted-foreground)]"
          >
            {todos.length}
          </span>
          {pendingCount > 0 && (
            <span
              title="未完成"
              className="flex-shrink-0 rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning)]"
            >
              未完成 {pendingCount}
            </span>
          )}
          {todos.length - pendingCount > 0 && (
            <span
              title="已完成"
              className="flex-shrink-0 rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-success)]"
            >
              已完成 {todos.length - pendingCount}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
        ) : (
          <ChevronUp className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
        )}
      </button>

      {open && (
        <div className={`overflow-y-auto ${maxHeightClass} px-6 pb-4`}>
          <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-xs)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-[var(--color-muted-foreground)]">
                共 {todos.length} 条 · 未完成 {pendingCount}
              </span>
              <button
                onClick={onCreate}
                className="btn-primary text-xs"
              >
                <Plus className="h-3.5 w-3.5" />
                新建待办
              </button>
            </div>

            {todos.length === 0 ? (
              <p className="py-2 text-center text-sm text-[var(--color-muted-foreground)]">暂无待办，点击「新建待办」为当前内容添加一条任务。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {todos.map((todo) => (
                  <div
                    key={todo.id}
                    className="group flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 transition-all hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-xs)]"
                  >
                    <button
                      type="button"
                      onClick={() => onToggle(todo)}
                      className={cn(
                        'mt-0.5 flex-shrink-0 rounded p-0.5 transition-colors',
                        todo.done ? 'text-[var(--color-success)] hover:text-[var(--color-success)]' : 'text-[var(--color-muted-foreground)]/60 hover:text-[var(--color-warning)]'
                      )}
                      title={todo.done ? '标记为未完成' : '标记为已完成'}
                    >
                      {todo.done ? (
                        <CheckSquare className="h-5 w-5" />
                      ) : (
                        <Square className="h-5 w-5" />
                      )}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          'break-words text-sm font-medium',
                          todo.done ? 'text-[var(--color-muted-foreground)] line-through' : 'text-[var(--color-foreground)]'
                        )}
                      >
                        {todo.title || '未命名待办'}
                      </div>
                      {todo.detail && (
                        <p
                          className={cn(
                            'mt-0.5 break-words text-xs',
                            todo.done ? 'text-[var(--color-muted-foreground)]/60' : 'text-[var(--color-muted-foreground)]'
                          )}
                        >
                          {todo.detail}
                        </p>
                      )}
                      <div className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">{formatDate(todo.updatedAt)}</div>
                    </div>

                    <button
                      onClick={() => onDelete(todo.id)}
                      className="flex-shrink-0 rounded p-1 text-[var(--color-muted-foreground)]/60 opacity-0 transition-all hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
