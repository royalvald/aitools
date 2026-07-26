import { useEffect, useMemo, useState } from 'react'
import { TodoListItem } from './TodoListItem'
import { EmptyState } from './EmptyState'
import { cn } from '../lib/utils'
import type { KnowledgeBaseDocSummary, NoteSummary, Todo } from '../types'

export type TodoFilter = 'all' | 'pending' | 'done'

interface TodoListProps {
  todos: Todo[]
  isLoading: boolean
  onToggle: (todo: Todo) => void
  onEdit: (todo: Todo) => void
  onDelete: (id: string) => void
  onOpenTarget: (todo: Todo) => void
}

/**
 * 待办列表主区域。
 *
 * 为了在列表项里展示「关联对象的名称」并判定关联是否失效，
 * 加载时一次性拉取所有 Note 摘要 + 所有 KB Doc 摘要建立 id→名称 索引。
 * Note id 全局唯一可直接建表；KB Doc id 全局唯一但分散在各 KB 目录下，
 * 通过遍历每个 KB 的文档列表聚合。
 */
export function TodoList({ todos, isLoading, onToggle, onEdit, onDelete, onOpenTarget }: TodoListProps) {
  const [filter, setFilter] = useState<TodoFilter>('all')
  const [noteIndex, setNoteIndex] = useState<Record<string, NoteSummary>>({})
  const [docIndex, setDocIndex] = useState<Record<string, KnowledgeBaseDocSummary>>({})

  // 加载所有 Note / KB Doc 元数据，用于解析关联对象名称
  useEffect(() => {
    let cancelled = false
    async function loadTargets() {
      const notes = await window.electronAPI.listNotes()
      const noteMap: Record<string, NoteSummary> = {}
      for (const n of notes) noteMap[n.id] = n

      const docMap: Record<string, KnowledgeBaseDocSummary> = {}
      const kbs = await window.electronAPI.listKnowledgeBases()
      for (const kb of kbs) {
        const docs = await window.electronAPI.listKbDocs(kb.id)
        for (const d of docs) docMap[d.id] = d
      }
      if (!cancelled) {
        setNoteIndex(noteMap)
        setDocIndex(docMap)
      }
    }
    loadTargets()
    return () => {
      cancelled = true
    }
  }, [todos])

  /**
   * 解析关联对象名称。
   * - 有名称字符串：关联有效
   * - null：有关联 id 但对应对象已被删除（关联失效）
   * 关联对象是否存在的判定由调用方根据 targetId 是否为空决定。
   */
  const resolveTargetLabel = (todo: Todo): string | null => {
    if (todo.targetType === 'note') {
      const n = noteIndex[todo.targetId]
      return n ? n.title || '无标题' : null
    }
    const d = docIndex[todo.targetId]
    return d ? d.name || '未命名文档' : null
  }

  const filtered = useMemo(() => {
    if (filter === 'pending') return todos.filter((t) => !t.done)
    if (filter === 'done') return todos.filter((t) => t.done)
    return todos
  }, [todos, filter])

  const pendingCount = todos.filter((t) => !t.done).length
  const doneCount = todos.length - pendingCount

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-[var(--color-muted-foreground)]">加载中…</div>
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 顶部标题与筛选 */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-6 py-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-[var(--color-foreground)]">待办任务</h2>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-[var(--color-muted-foreground)]">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-border-strong)]" />
              共 {todos.length}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-warning)]" />
              未完成 {pendingCount}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-success)]" />
              已完成 {doneCount}
            </span>
          </p>
        </div>
        <div className="segmented">
          {(
            [
              { key: 'all' as const, label: '全部' },
              { key: 'pending' as const, label: '未完成' },
              { key: 'done' as const, label: '已完成' }
            ]
          ).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setFilter(opt.key)}
              className={cn(
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                filter === opt.key
                  ? 'bg-[var(--color-surface)] text-[var(--color-foreground)] shadow-sm'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {todos.length === 0 ? (
          <EmptyState
            title="还没有待办任务"
            description="在文档或笔记的顶部工具栏点击「待办」，即可为它创建一条待办任务。"
          />
        ) : filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted-foreground)]">
            {filter === 'pending' ? '没有未完成的待办' : '没有已完成的待办'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((todo) => (
              <TodoListItem
                key={todo.id}
                todo={todo}
                hasTarget={!!todo.targetId}
                targetLabel={resolveTargetLabel(todo)}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
                onOpenTarget={onOpenTarget}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
