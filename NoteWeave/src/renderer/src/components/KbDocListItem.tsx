import { MessageSquareText, Star, Trash2 } from 'lucide-react'
import { formatDate } from '../lib/utils'
import { cn } from '../lib/utils'
import type { KnowledgeBaseDocSummary } from '../types'

interface KbDocListItemProps {
  doc: KnowledgeBaseDocSummary
  isActive: boolean
  onClick: () => void
  onDelete: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
}

export function KbDocListItem({
  doc,
  isActive,
  onClick,
  onDelete,
  isFavorite = false,
  onToggleFavorite
}: KbDocListItemProps) {
  return (
    <button
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          'application/x-noteweave-card',
          JSON.stringify({
            targetKind: 'kbDoc',
            targetId: doc.id,
            kbId: doc.kbId,
            title: doc.name || '未命名文档',
            summary: doc.annotationCount ? `${doc.annotationCount} 条批注` : undefined
          })
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className={`group relative w-full rounded-lg border px-4 py-3 text-left transition-colors ${
        isActive
          ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]'
          : 'border-transparent bg-surface hover:bg-[var(--color-surface-2)]'
      }`}
    >
      <div className="mb-1 pr-6 font-medium text-[var(--color-foreground)]">{doc.name || '未命名文档'}</div>
      {doc.linkedNoteIds && doc.linkedNoteIds.length > 0 && (
        <div className="mb-1 text-xs text-[var(--color-muted-foreground)]">关联 {doc.linkedNoteIds.length} 条笔记</div>
      )}
      {doc.annotationCount && doc.annotationCount > 0 && (
        <div className="mb-1 flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
          <MessageSquareText className="h-3 w-3" />
          {doc.annotationCount} 条批注
        </div>
      )}
      {doc.tags && doc.tags.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {doc.tags.slice(0, 2).map((tag) => (
            <span
              key={tag}
              className="badge badge-primary"
            >
              {tag}
            </span>
          ))}
          {doc.tags.length > 2 && (
            <span className="text-[10px] text-[var(--color-muted-foreground)]">+{doc.tags.length - 2}</span>
          )}
        </div>
      )}
      <span className="text-xs text-[var(--color-muted-foreground)]">{formatDate(doc.updatedAt)}</span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="absolute right-2 top-2 rounded p-1 text-[var(--color-muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
        title="删除"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      {onToggleFavorite && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation()
              e.preventDefault()
              onToggleFavorite()
            }
          }}
          className={cn(
            'absolute right-8 top-2 rounded p-1 transition-opacity hover:bg-[var(--color-warning-soft)] hover:text-[var(--color-warning)]',
            isFavorite
              ? 'text-amber-400 opacity-100'
              : 'text-[var(--color-muted-foreground)] opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
          )}
          title={isFavorite ? '取消收藏' : '加入收藏'}
        >
          <Star className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
        </span>
      )}
    </button>
  )
}
