import { useEffect, useMemo, useState } from 'react'
import {
  FileText,
  FolderPlus,
  Library,
  ListTodo,
  Pin,
  PinOff,
  Plus,
  Search,
  StickyNote,
  X
} from 'lucide-react'
import { TagFilterBar } from './TagFilterBar'
import { NoteGroupTree } from './NoteGroupTree'
import { CreateNoteGroupDialog } from './CreateNoteGroupDialog'
import { TodoList } from './TodoList'
import { EmptyState } from './EmptyState'
import { cn } from '../lib/utils'
import type {
  FavoriteItem,
  NoteGroup,
  NoteSummary,
  PinnedItem,
  RecentItem,
  Todo
} from '../types'

// 语雀风格「工作台」首页：问候 + 快捷操作 + Tab（最近访问 / 收藏 / 小记 / 待办）。
// 固定/最近数据与 RecentPinnedSection 同源（settings.pinnedItems / settings.recentItems）。

export interface DashboardProps {
  notes: NoteSummary[]
  groups: NoteGroup[]
  onSelectNote: (id: string) => void
  onCreateNote: () => void
  onCreateNoteInGroup: (groupId: string | null) => void
  onDeleteNote: (id: string) => void
  onCreateGroup: (name: string, parentId: string | null) => Promise<void>
  onUpdateGroup: (id: string, name: string) => Promise<void>
  onDeleteGroup: (id: string) => Promise<void>
  isNoteFavorite: (id: string) => boolean
  onToggleNoteFavorite: (id: string, title: string) => void
  favorites: FavoriteItem[]
  onOpenFavorite: (fav: FavoriteItem) => void
  onRemoveFavorite: (kind: 'note' | 'kbDoc', id: string) => void
  todos: Todo[]
  todosLoading: boolean
  onCreateTodo: () => void
  onToggleTodo: (id: string) => void
  onEditTodo: (todo: Todo) => void
  onDeleteTodo: (id: string) => void
  onOpenTodoTarget: (todo: Todo) => void
  onOpenKbDoc: (kbId: string, docId: string) => void
  onOpenSearch: () => void
  onCreateKb: () => void
}

type DashboardTab = 'recent' | 'favorites' | 'notes' | 'todos'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function greetingOf(hour: number): string {
  if (hour >= 5 && hour < 9) return '早上好'
  if (hour >= 9 && hour < 12) return '上午好'
  if (hour >= 12 && hour < 14) return '中午好'
  if (hour >= 14 && hour < 18) return '下午好'
  if (hour >= 18 && hour < 23) return '晚上好'
  return '夜深了'
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${WEEKDAYS[d.getDay()]}`
}

export function Dashboard({
  notes,
  groups,
  onSelectNote,
  onCreateNote,
  onCreateNoteInGroup,
  onDeleteNote,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  isNoteFavorite,
  onToggleNoteFavorite,
  favorites,
  onOpenFavorite,
  onRemoveFavorite,
  todos,
  todosLoading,
  onCreateTodo,
  onToggleTodo,
  onEditTodo,
  onDeleteTodo,
  onOpenTodoTarget,
  onOpenKbDoc,
  onOpenSearch,
  onCreateKb
}: DashboardProps) {
  const [activeTab, setActiveTab] = useState<DashboardTab>('recent')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [showCreateGroup, setShowCreateGroup] = useState(false)

  // ---- 最近访问：固定 / 最近（与 RecentPinnedSection 同源）----
  const [pinned, setPinned] = useState<PinnedItem[]>([])
  const [recent, setRecent] = useState<RecentItem[]>([])

  const reloadRecent = async () => {
    const s = await window.electronAPI.getSettings()
    setPinned(s.pinnedItems ?? [])
    setRecent(s.recentItems ?? [])
  }

  useEffect(() => {
    void reloadRecent()
  }, [])

  const openRecentItem = (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string }) => {
    if (item.kind === 'note') onSelectNote(item.id)
    else if (item.kbId) onOpenKbDoc(item.kbId, item.id)
    void reloadRecent()
  }

  const togglePin = async (
    e: React.MouseEvent,
    item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string },
    isPinned: boolean
  ) => {
    e.stopPropagation()
    if (isPinned) await window.electronAPI.unpinItem(item.kind, item.id)
    else await window.electronAPI.pinItem(item)
    void reloadRecent()
  }

  // ---- 小记：标签聚合与筛选（照搬 Sidebar 的接线）----
  const { tags, counts } = useMemo(() => {
    const map = new Map<string, number>()
    for (const n of notes) {
      for (const t of n.tags ?? []) {
        map.set(t, (map.get(t) ?? 0) + 1)
      }
    }
    const sorted = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    return {
      tags: sorted,
      counts: Object.fromEntries(map) as Record<string, number>
    }
  }, [notes])

  const visibleNotes = useMemo(
    () => (activeTag ? notes.filter((n) => n.tags?.includes(activeTag)) : notes),
    [notes, activeTag]
  )

  const pendingTodoCount = useMemo(() => todos.filter((t) => !t.done).length, [todos])

  const now = new Date()

  const quickActions = [
    { label: '新建小记', icon: StickyNote, onClick: onCreateNote },
    { label: '新建知识库', icon: Library, onClick: onCreateKb },
    { label: '新建待办', icon: ListTodo, onClick: onCreateTodo }
  ]

  const tabs: { key: DashboardTab; label: string; badge?: number }[] = [
    { key: 'recent', label: '最近访问' },
    { key: 'favorites', label: '收藏' },
    { key: 'notes', label: '小记' },
    { key: 'todos', label: '待办', badge: pendingTodoCount }
  ]

  const renderRecentRow = (
    item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string },
    isPinned: boolean,
    key: string
  ) => (
    <div
      key={key}
      className="group flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-[var(--nw-border)] bg-[var(--nw-surface)] px-4 py-2.5 hover:border-[var(--nw-border-strong)] hover:shadow-[var(--shadow-sm)]"
      onClick={() => openRecentItem(item)}
      title={item.title}
    >
      {item.kind === 'note' ? (
        <StickyNote size={16} className="shrink-0 text-[var(--color-muted-foreground)]" />
      ) : (
        <FileText size={16} className="shrink-0 text-[var(--color-muted-foreground)]" />
      )}
      <span className="flex-1 truncate text-sm">{item.title}</span>
      <button
        className="btn-icon opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        title={isPinned ? '取消固定' : '固定'}
        onClick={(e) => togglePin(e, item, isPinned)}
      >
        {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  )

  const renderRecentTab = () => {
    if (pinned.length === 0 && recent.length === 0) {
      return (
        <EmptyState
          title="暂无最近访问"
          description="打开任意小记或知识库文档后，会在这里留下访问记录。"
          icon={FileText}
        />
      )
    }
    return (
      <div className="flex flex-col gap-5">
        {pinned.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">固定</div>
            <div className="flex flex-col gap-2">
              {pinned.slice(0, 10).map((p) =>
                renderRecentRow(
                  { kind: p.kind, id: p.id, kbId: p.kbId, title: p.title },
                  true,
                  `${p.kind}-${p.id}`
                )
              )}
            </div>
          </div>
        )}
        {recent.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">最近</div>
            <div className="flex flex-col gap-2">
              {recent.slice(0, 10).map((r) =>
                renderRecentRow(
                  { kind: r.kind, id: r.id, kbId: r.kbId, title: r.title },
                  pinned.some((p) => p.kind === r.kind && p.id === r.id),
                  `${r.kind}-${r.id}-${r.openedAt}`
                )
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderFavoritesTab = () => {
    if (favorites.length === 0) {
      return (
        <EmptyState
          title="暂无收藏"
          description="在小记或文档上点击星标，即可加入收藏。"
          icon={FileText}
        />
      )
    }
    return (
      <div className="flex flex-col gap-2">
        {favorites.map((fav) => (
          <div
            key={`${fav.kind}-${fav.id}`}
            className="group flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-[var(--nw-border)] bg-[var(--nw-surface)] px-4 py-2.5 hover:border-[var(--nw-border-strong)] hover:shadow-[var(--shadow-sm)]"
            onClick={() => onOpenFavorite(fav)}
            title={fav.title}
          >
            {fav.kind === 'note' ? (
              <StickyNote size={16} className="shrink-0 text-[var(--color-muted-foreground)]" />
            ) : (
              <FileText size={16} className="shrink-0 text-[var(--color-muted-foreground)]" />
            )}
            <span className="flex-1 truncate text-sm">{fav.title}</span>
            <span className="text-xs text-[var(--color-muted-foreground)]">
              {fav.kind === 'note' ? '小记' : '文档'}
            </span>
            <button
              className="btn-icon opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              title="取消收藏"
              onClick={(e) => {
                e.stopPropagation()
                onRemoveFavorite(fav.kind, fav.id)
              }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const renderNotesTab = () => (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">全部小记</h2>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setShowCreateGroup(true)}>
            <FolderPlus className="h-4 w-4" />
            新建分组
          </button>
          <button className="btn-primary" onClick={onCreateNote}>
            <Plus className="h-4 w-4" />
            新建小记
          </button>
        </div>
      </div>
      <TagFilterBar tags={tags} counts={counts} activeTag={activeTag} onChange={setActiveTag} />
      <NoteGroupTree
        notes={visibleNotes}
        groups={groups}
        selectedId={null}
        onSelect={onSelectNote}
        onDeleteNote={onDeleteNote}
        onCreateGroup={onCreateGroup}
        onUpdateGroup={onUpdateGroup}
        onDeleteGroup={onDeleteGroup}
        onCreateNoteInGroup={onCreateNoteInGroup}
        isFavorite={isNoteFavorite}
        onToggleFavorite={onToggleNoteFavorite}
      />
      {showCreateGroup && (
        <CreateNoteGroupDialog
          onClose={() => setShowCreateGroup(false)}
          onCreate={(name) => void onCreateGroup(name, null)}
        />
      )}
    </div>
  )

  const renderTodosTab = () => (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">待办任务</h2>
        <button className="btn-primary" onClick={onCreateTodo}>
          <Plus className="h-4 w-4" />
          新建待办
        </button>
      </div>
      <TodoList
        todos={todos}
        isLoading={todosLoading}
        onToggle={(todo) => onToggleTodo(todo.id)}
        onEdit={onEditTodo}
        onDelete={onDeleteTodo}
        onOpenTarget={onOpenTodoTarget}
      />
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 页头 */}
      <div className="border-b border-[var(--nw-border)] px-8 pb-0 pt-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{greetingOf(now.getHours())}</h1>
            <div className="mt-1 text-sm text-muted-foreground">{formatDate(now)}</div>
          </div>
          <button
            onClick={onOpenSearch}
            className="flex flex-shrink-0 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--nw-border)] bg-[var(--nw-surface-2)] px-3 py-1.5 text-sm text-muted-foreground"
          >
            <Search size={14} />
            <span className="hidden md:inline">搜索笔记、文档…</span>
            <kbd className="ml-2 hidden rounded border border-[var(--nw-border)] bg-[var(--nw-surface)] px-1.5 py-0.5 text-[10px] xl:inline">
              Ctrl+Shift+F
            </kbd>
          </button>
        </div>

        {/* 快捷操作（窄窗口自动换行） */}
        <div className="mt-5 flex flex-wrap gap-3">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={action.onClick}
              className="surface-elevated flex items-center gap-3 px-4 py-3 transition-shadow hover:shadow-[var(--shadow-md)]"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--nw-accent-soft)] text-[var(--nw-primary)]">
                <action.icon size={16} />
              </span>
              <span className="text-sm font-medium">{action.label}</span>
            </button>
          ))}
        </div>

        {/* Tab 栏 */}
        <div className="mt-5 flex gap-5 border-t border-transparent">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={cn('dash-tab', activeTab === tab.key && 'is-active')}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {typeof tab.badge === 'number' && tab.badge > 0 && (
                <span className="badge ml-1">{tab.badge}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-8 py-5">
        {activeTab === 'recent' && renderRecentTab()}
        {activeTab === 'favorites' && renderFavoritesTab()}
        {activeTab === 'notes' && renderNotesTab()}
        {activeTab === 'todos' && renderTodosTab()}
      </div>
    </div>
  )
}
