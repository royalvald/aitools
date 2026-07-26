import { Tag } from 'lucide-react'
import { cn } from '../lib/utils'

interface TagFilterBarProps {
  /** 所有可用标签（去重），由外部聚合 */
  tags: string[]
  /** 每个标签的命中条数 */
  counts?: Record<string, number>
  activeTag: string | null
  onChange: (tag: string | null) => void
}

// REQ-012 标签筛选：横向 chip 列表，「全部」+ 各标签（带计数）。
// 点击 chip 设置 activeTag，再次点击或点「全部」取消筛选。
export function TagFilterBar({ tags, counts, activeTag, onChange }: TagFilterBarProps) {
  if (tags.length === 0) return null
  return (
    <div className="border-b border-[var(--color-border)] px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-[var(--color-muted-foreground)]">
        <Tag className="h-3 w-3" />
        按标签筛选
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => onChange(null)}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] transition-colors',
            activeTag === null
              ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
              : 'bg-[var(--nw-ghost-hover)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
          )}
        >
          全部
        </button>
        {tags.map((tag) => {
          const active = activeTag === tag
          const count = counts?.[tag]
          return (
            <button
              key={tag}
              onClick={() => onChange(active ? null : tag)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
                active
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)] hover:bg-[var(--color-accent-soft)]'
              )}
            >
              {tag}
              {typeof count === 'number' && (
                <span className={cn('text-[10px]', active ? 'opacity-80' : 'opacity-60')}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
