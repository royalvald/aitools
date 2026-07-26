import { FileText, type LucideIcon } from 'lucide-react'

interface EmptyStateAction {
  label: string
  onClick: () => void
  variant?: 'primary' | 'secondary'
}

interface EmptyStateProps {
  title?: string
  description?: string
  icon?: LucideIcon
  actions?: EmptyStateAction[]
}

export function EmptyState({
  title = '还没有笔记',
  description = '点击左侧“新建笔记”开始创建你的第一篇 Markdown 笔记。',
  icon: Icon = FileText,
  actions
}: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center text-[var(--color-muted-foreground)]">
      <div className="mb-4 rounded-2xl bg-[var(--color-muted)] p-5">
        <Icon className="h-10 w-10 text-[var(--color-muted-foreground)]" />
      </div>
      <h2 className="mb-1 text-lg font-semibold text-[var(--color-foreground)]">{title}</h2>
      <p className="max-w-xs text-sm">{description}</p>
      {actions && actions.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={action.onClick}
              className={action.variant === 'primary' ? 'btn-primary' : 'btn-secondary'}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
