import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, Inbox, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { NoteListItem } from './NoteListItem'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { cn } from '../lib/utils'
import type { NoteGroup, NoteSummary } from '../types'

interface NoteGroupTreeProps {
  notes: NoteSummary[]
  groups: NoteGroup[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDeleteNote: (id: string) => void
  onCreateGroup: (name: string, parentId: string | null) => Promise<unknown>
  onUpdateGroup: (id: string, name: string) => Promise<unknown>
  onDeleteGroup: (id: string) => Promise<unknown>
  onCreateNoteInGroup: (groupId: string | null) => void
  isFavorite?: (id: string) => boolean
  onToggleFavorite?: (id: string, title: string) => void
}

// 一个虚拟常量，代表"未分类"分组（groupId 为空/null 的提示）。
const UNCLASSIFIED_KEY = '__unclassified__'

export function NoteGroupTree({
  notes,
  groups,
  selectedId,
  onSelect,
  onDeleteNote,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onCreateNoteInGroup,
  isFavorite,
  onToggleFavorite
}: NoteGroupTreeProps) {
  const confirm = useConfirm()
  // 展开状态：记录「已展开」的分组 id（以及 UNCLASSIFIED_KEY）。
  // 默认全部折叠——用户主动点开的目录才会展开，不自动展开。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (key: string) => setExpanded((m) => ({ ...m, [key]: !m[key] }))

  // 节点「⋯」操作菜单：记录当前打开的分组 id（null 表示一级通用入口）
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // 重命名 / 新建子分组 弹窗状态
  const [renameTarget, setRenameTarget] = useState<NoteGroup | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [addChildParent, setAddChildParent] = useState<NoteGroup | null>(null)
  const [addChildValue, setAddChildValue] = useState('')

  const topLevel = useMemo(() => groups.filter((g) => g.parentId === null), [groups])
  const childrenOf = (parentId: string) => groups.filter((g) => g.parentId === parentId)
  const notesOf = (groupId: string | null) =>
    notes.filter((n) => (n.groupId ?? null) === groupId)

  const handleDeleteGroup = async (group: NoteGroup) => {
    const hasChildren = childrenOf(group.id).length > 0
    const message = hasChildren
      ? `确定要删除分组「${group.name}」及其全部子分组吗？\n组内的笔记不会被删除，会变为未分类。`
      : `确定要删除分组「${group.name}」吗？\n组内的笔记不会被删除，会变为未分类。`
    const ok = await confirm({
      title: '删除分组',
      description: message,
      confirmText: '删除',
      danger: true
    })
    if (ok) {
      void onDeleteGroup(group.id)
    }
    setMenuFor(null)
  }

  const submitRename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!renameTarget || !renameValue.trim()) return
    await onUpdateGroup(renameTarget.id, renameValue.trim())
    setRenameTarget(null)
    setRenameValue('')
  }

  const submitAddChild = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addChildParent || !addChildValue.trim()) return
    await onCreateGroup(addChildValue.trim(), addChildParent.id)
    setAddChildParent(null)
    setAddChildValue('')
  }

  const renderGroupNode = (group: NoteGroup, level: number) => {
    const isTop = group.parentId === null
    const isCollapsed = !expanded[group.id]
    const childGroups = isTop ? childrenOf(group.id) : []
    const groupNotes = notesOf(group.id)
    return (
      <div key={group.id}>
        <div
          className="group/node relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
          style={level > 0 ? { paddingLeft: `${0.5 + level}rem` } : undefined}
        >
          <button
            onClick={() => toggle(group.id)}
            aria-expanded={!isCollapsed}
            className="btn-icon"
            title={isCollapsed ? '展开' : '折叠'}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          {isCollapsed ? (
            <FolderClosed className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          ) : (
            <FolderOpen className="h-4 w-4 flex-shrink-0 text-[var(--color-warning)]" />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              isTop ? 'font-semibold' : 'font-medium'
            )}
          >
            {group.name}
          </span>
          {groupNotes.length > 0 && (
            <span className="badge">
              {groupNotes.length}
            </span>
          )}
          <button
            onClick={() => onCreateNoteInGroup(group.id)}
            className="btn-icon opacity-0 focus-visible:opacity-100 group-hover/node:opacity-100"
            title="在分组内新建笔记"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setMenuFor((cur) => (cur === group.id ? null : group.id))}
            className="btn-icon opacity-0 focus-visible:opacity-100 group-hover/node:opacity-100"
            title="分组操作"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {menuFor === group.id && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuFor(null)} />
              <div className="absolute right-2 top-8 z-40 w-36 overflow-hidden rounded-lg border border-[var(--color-border)] bg-surface py-1 text-sm shadow-[var(--shadow-md)]">
                {isTop && (
                  <button
                    onClick={() => {
                      setAddChildParent(group)
                      setAddChildValue('')
                      setMenuFor(null)
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    新建子分组
                  </button>
                )}
                <button
                  onClick={() => {
                    setRenameTarget(group)
                    setRenameValue(group.name)
                    setMenuFor(null)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  重命名
                </button>
                <button
                  onClick={() => handleDeleteGroup(group)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger-soft)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除分组
                </button>
              </div>
            </>
          )}
        </div>

        {!isCollapsed && (
          <div className="flex flex-col gap-1.5">
            {childGroups.map((child) => renderGroupNode(child, level + 1))}
            {groupNotes.length === 0 && childGroups.length === 0 ? (
              <div
                className="px-3 text-xs text-[var(--color-muted-foreground)]"
                style={{ paddingLeft: `${1 + level}rem` }}
              >
                暂无笔记
              </div>
            ) : (
              groupNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={note.id === selectedId}
                  onClick={() => onSelect(note.id)}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: '删除笔记',
                      description: '确定要删除这条笔记吗？',
                      confirmText: '删除',
                      danger: true
                    })
                    if (ok) {
                      onDeleteNote(note.id)
                    }
                  }}
                  isFavorite={isFavorite?.(note.id)}
                  onToggleFavorite={
                    onToggleFavorite ? () => onToggleFavorite(note.id, note.title || '无标题') : undefined
                  }
                  indent={level + 1}
                />
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const unclassifiedNotes = notesOf(null)
  const totalNotes = notes.length
  const hasAnyGroup = topLevel.length > 0

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {/* 未分类分组：始终显示（即使有分组，未分类的提示也要能访问） */}
      <div>
        <div className="group/node relative flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]">
          <button
            onClick={() => toggle(UNCLASSIFIED_KEY)}
            className="btn-icon"
            title={expanded[UNCLASSIFIED_KEY] ? '折叠' : '展开'}
          >
            {expanded[UNCLASSIFIED_KEY] ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <Inbox className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          <span className="min-w-0 flex-1 truncate">未分类</span>
          {unclassifiedNotes.length > 0 && (
            <span className="badge">
              {unclassifiedNotes.length}
            </span>
          )}
          <button
            onClick={() => onCreateNoteInGroup(null)}
            className="btn-icon opacity-0 group-hover/node:opacity-100"
            title="新建笔记"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {expanded[UNCLASSIFIED_KEY] && (
          <div className="flex flex-col gap-1.5">
            {unclassifiedNotes.length === 0 && hasAnyGroup ? (
              <div className="px-3 text-xs text-[var(--color-muted-foreground)]">暂无未分类笔记</div>
            ) : (
              unclassifiedNotes.map((note) => (
                <NoteListItem
                  key={note.id}
                  note={note}
                  isActive={note.id === selectedId}
                  onClick={() => onSelect(note.id)}
                  onDelete={async () => {
                    const ok = await confirm({
                      title: '删除笔记',
                      description: '确定要删除这条笔记吗？',
                      confirmText: '删除',
                      danger: true
                    })
                    if (ok) {
                      onDeleteNote(note.id)
                    }
                  }}
                  isFavorite={isFavorite?.(note.id)}
                  onToggleFavorite={
                    onToggleFavorite ? () => onToggleFavorite(note.id, note.title || '无标题') : undefined
                  }
                />
              ))
            )}
          </div>
        )}
      </div>

      {topLevel.map((g) => renderGroupNode(g, 0))}

      {/* 重命名弹窗 */}
      {renameTarget && (
        <Modal title="重命名分组" onClose={() => setRenameTarget(null)}>
          <form onSubmit={submitRename} className="flex flex-col gap-4">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="分组名称"
              className="input"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="btn-ghost"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!renameValue.trim()}
                className="btn-primary disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* 新建子分组弹窗 */}
      {addChildParent && (
        <Modal title={`在「${addChildParent.name}」下新建子分组`} onClose={() => setAddChildParent(null)}>
          <form onSubmit={submitAddChild} className="flex flex-col gap-4">
            <input
              type="text"
              value={addChildValue}
              onChange={(e) => setAddChildValue(e.target.value)}
              placeholder="子分组名称"
              className="input"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddChildParent(null)}
                className="btn-ghost"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={!addChildValue.trim()}
                className="btn-primary disabled:cursor-not-allowed"
              >
                创建
              </button>
            </div>
          </form>
        </Modal>
      )}

      <div className="mt-1 px-2 text-xs text-[var(--color-muted-foreground)]">共 {totalNotes} 条笔记</div>
    </div>
  )
}
