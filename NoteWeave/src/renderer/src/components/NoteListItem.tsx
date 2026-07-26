import { Star, Trash2 } from 'lucide-react'
import { NotePreview } from './NotePreview'
import { formatDate } from '../lib/utils'
import { cn } from '../lib/utils'
import type { NoteSummary } from '../types'

interface NoteListItemProps {
  note: NoteSummary
  isActive: boolean
  onClick: () => void
  onDelete: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  indent?: number // 树形分组内的缩进层级（0=顶层/未分类，1=二级分组内的提示）
}

export function NoteListItem({
  note,
  isActive,
  onClick,
  onDelete,
  isFavorite = false,
  onToggleFavorite,
  indent = 0
}: NoteListItemProps) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          'application/x-noteweave-card',
          JSON.stringify({
            targetKind: 'note',
            targetId: note.id,
            title: note.title || '无标题',
            summary: note.summary
          })
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      style={{ paddingLeft: indent > 0 ? `${0.75 + indent}rem` : undefined }}
      className={cn(
        'group relative w-full cursor-pointer rounded-lg border py-2.5 pr-3 pl-3 text-left transition-all',
        isActive
          ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] shadow-[var(--shadow-xs)]'
          : 'border-[var(--color-border)] bg-surface hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)] hover:shadow-[var(--shadow-xs)]'
      )}
    >
      {/* 选中态左侧强调竖条 */}
      {isActive && (
        <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--color-accent)]" />
      )}

      <div className="mb-1 pr-6 text-sm font-semibold text-[var(--color-foreground)]">
        <NotePreview
          markdown={note.title || '无标题'}
          allowedElements={['strong', 'em', 'code', 'a', 'del', 'span']}
        />
      </div>
      {note.summary && (
        <p className="mb-1.5 line-clamp-2 text-xs leading-relaxed text-[var(--color-muted-foreground)]">{note.summary}</p>
      )}
      {note.tags && note.tags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {note.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="badge badge-primary"
            >
              {tag}
            </span>
          ))}
          {note.tags.length > 2 && (
            <span className="text-[10px] text-[var(--color-muted-foreground)]">+{note.tags.length - 2}</span>
          )}
        </div>
      )}
      <span className="inline-flex rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-muted-foreground)]">
        {formatDate(note.updatedAt)}
      </span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="absolute right-2 top-2 rounded-md p-1 text-[var(--color-muted-foreground)] opacity-0 transition-all hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
        title="删除"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      {onToggleFavorite && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            'absolute right-8 top-2 rounded-md p-1 transition-all hover:bg-[var(--color-warning-soft)] hover:text-[var(--color-warning)]',
            isFavorite
              ? 'text-amber-400 opacity-100'
              : 'text-[var(--color-muted-foreground)] opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
          )}
          title={isFavorite ? '取消收藏' : '加入收藏'}
        >
          <Star className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  )
}
