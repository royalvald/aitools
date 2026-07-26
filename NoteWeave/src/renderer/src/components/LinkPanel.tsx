import { Link2, Plus, X } from 'lucide-react'

interface LinkItem {
  id: string
  title: string
  subtitle?: string
}

interface LinkPanelProps {
  title: string
  items: LinkItem[]
  emptyText: string
  addLabel: string
  onAdd: () => void
  onUnlink: (id: string) => void
  onItemClick?: (id: string) => void
  onCreate?: () => void
  createLabel?: string
}

export function LinkPanel({ title, items, emptyText, addLabel, onAdd, onUnlink, onItemClick, onCreate, createLabel }: LinkPanelProps) {
  return (
    <div className="mt-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
          <Link2 className="h-4 w-4" />
          {title}
        </div>
        <div className="flex items-center gap-2">
          {onCreate && (
            <button
              onClick={onCreate}
              className="btn-secondary text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              {createLabel || '新建'}
            </button>
          )}
          <button
            onClick={onAdd}
            className="btn-primary text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">{emptyText}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="group flex items-start justify-between gap-2 rounded-md border border-[var(--color-border)] bg-surface px-3 py-2"
            >
              <button
                type="button"
                onClick={() => onItemClick?.(item.id)}
                className={`min-w-0 flex-1 text-left ${onItemClick ? 'cursor-pointer hover:text-[var(--color-primary)]' : 'cursor-default'}`}
              >
                <div className="truncate text-sm font-medium text-[var(--color-foreground)]">{item.title}</div>
                {item.subtitle && (
                  <div className="truncate text-xs text-[var(--color-muted-foreground)]">{item.subtitle}</div>
                )}
              </button>
              <button
                onClick={() => onUnlink(item.id)}
                className="rounded p-1 text-[var(--color-muted-foreground)] opacity-100 transition-colors hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100 sm:opacity-0 sm:focus-visible:opacity-100"
                title="取消关联"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
