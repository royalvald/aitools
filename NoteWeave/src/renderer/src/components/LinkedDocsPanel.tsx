import { useState } from 'react'
import { Link2, Plus, Trash2, X } from 'lucide-react'
import type { KnowledgeBaseDocSummary } from '../types'

interface LinkedDocsPanelProps {
  linkedDocs: KnowledgeBaseDocSummary[]
  onOpenKbDoc?: (kbId: string, docId: string) => void
  onRemoveLink?: (docId: string) => void | Promise<void>
  onAdd: () => void
  onCreate: () => void
}

/**
 * 「关联知识库文档」底部抽屉面板。
 * - 已关联文档显示「已关联」徽标，可取消关联。
 */
export function LinkedDocsPanel({
  linkedDocs,
  onOpenKbDoc,
  onRemoveLink,
  onAdd,
  onCreate
}: LinkedDocsPanelProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0 border-t border-[var(--color-border)] bg-surface-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-6 py-2.5 text-left transition-colors hover:bg-[var(--color-foreground)]/[0.03]"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-[var(--color-foreground)]">
          <Link2 className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          <span className="truncate">关联知识库文档</span>
          <span className="flex-shrink-0 rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-xs font-medium text-[var(--color-muted-foreground)]">
            {linkedDocs.length}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[var(--color-muted-foreground)]">
          {open ? (
            <X className="h-4 w-4 flex-shrink-0" />
          ) : (
            <Plus className="h-4 w-4 flex-shrink-0" />
          )}
        </div>
      </button>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto px-6 pb-4">
          {/* 操作按钮 */}
          <div className="mb-3 flex items-center gap-2">
            <button onClick={onAdd} className="btn-secondary text-xs">
              <Link2 className="h-3.5 w-3.5" />
              关联文档
            </button>
            <button onClick={onCreate} className="btn-ghost text-xs">
              <Plus className="h-3.5 w-3.5" />
              新建文档
            </button>
          </div>

          {/* 已关联列表 */}
          {linkedDocs.length === 0 && (
            <div className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">
              暂无关联文档，可关联或新建文档。
            </div>
          )}

          {linkedDocs.length > 0 && (
            <div className="mb-3">
              <div className="mb-1.5 text-xs font-medium text-[var(--color-muted-foreground)]">已关联</div>
              <div className="flex flex-col gap-1.5">
                {linkedDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="group flex items-center justify-between gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-ghost-hover)]"
                  >
                    <button
                      onClick={() => onOpenKbDoc?.(doc.kbId, doc.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm font-medium text-[var(--color-foreground)]">
                        {doc.name || '未命名文档'}
                      </div>
                    </button>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      <span className="rounded bg-[var(--color-success-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-success)]">
                        已关联
                      </span>
                      <button
                        onClick={() => onRemoveLink?.(doc.id)}
                        className="rounded p-1 text-[var(--color-muted-foreground)] opacity-0 transition-opacity hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                        title="取消关联"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
