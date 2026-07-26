import {
  FileText,
  ListTodo,
  MessageSquareText,
  Network,
  Plus
} from 'lucide-react'
import type { KnowledgeBase, KnowledgeBaseDocSummary } from '../types'

interface KbHomeProps {
  kb: KnowledgeBase
  docs: KnowledgeBaseDocSummary[]
  onSelectDoc: (id: string) => void
  onCreateDoc: () => void
  onCreateMindmapDoc?: () => void
  onEnterList?: () => void
}

const DOC_TYPE_ICONS: Record<string, typeof FileText> = {
  mindmap: Network,
  markdown: FileText
}

const DOC_TYPE_LABELS: Record<string, string> = {
  mindmap: '思维导图',
  markdown: '文档'
}

export function KbHome({
  kb,
  docs,
  onSelectDoc,
  onCreateDoc,
  onCreateMindmapDoc,
  onEnterList
}: KbHomeProps) {
  const recentDocs = [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6)
  const allTags = Array.from(
    new Set(docs.flatMap((d) => d.tags ?? []).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b))
  const totalAnnotations = docs.reduce((sum, d) => sum + (d.annotationCount ?? 0), 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[var(--nw-background)] p-6">
      {/* 头部 */}
      <div className="mb-6 flex items-start gap-4">
        <div
          className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl text-[var(--color-primary-foreground)] shadow-sm"
          style={{ background: 'linear-gradient(135deg, var(--nw-primary), var(--nw-accent))' }}
        >
          <span className="text-xl font-bold">{kb.name.slice(0, 1)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-[var(--nw-foreground)]">{kb.name}</h1>
          <p className="text-sm text-[var(--nw-muted-foreground)]">
            {kb.category} · {docs.length} 篇文档 · {totalAnnotations} 条批注
          </p>
        </div>
        {onEnterList && (
          <button onClick={onEnterList} className="btn-secondary">
            查看全部文档
          </button>
        )}
      </div>

      {/* 快捷创建 */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickCreateCard icon={FileText} label="Markdown 文档" onClick={onCreateDoc} />
        {onCreateMindmapDoc && <QuickCreateCard icon={Network} label="思维导图" onClick={onCreateMindmapDoc} />}
      </div>

      {/* 最近更新 */}
      <div className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--nw-foreground)]">最近更新</h2>
          {recentDocs.length > 0 && onEnterList && (
            <button onClick={onEnterList} className="text-xs text-[var(--nw-primary)] hover:underline">
              全部
            </button>
          )}
        </div>
        {recentDocs.length === 0 ? (
          <div className="surface-elevated flex flex-col items-center justify-center py-10 text-sm text-[var(--nw-muted-foreground)]">
            <FileText className="mb-2 h-8 w-8 opacity-50" />
            <p>还没有文档，从上方快捷创建一篇。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentDocs.map((doc) => {
              const Icon = DOC_TYPE_ICONS[doc.docType ?? 'markdown'] ?? FileText
              return (
                <button
                  key={doc.id}
                  onClick={() => onSelectDoc(doc.id)}
                  className="surface-elevated flex flex-col items-start gap-2 p-4 text-left transition-shadow hover:shadow-[var(--shadow-md)]"
                >
                  <div className="flex w-full items-center gap-2">
                    <Icon className="h-4 w-4 flex-shrink-0 text-[var(--nw-primary)]" />
                    <span className="flex-1 truncate text-sm font-medium text-[var(--nw-foreground)]">
                      {doc.name || '未命名文档'}
                    </span>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 text-xs text-[var(--nw-muted-foreground)]">
                    <span>{DOC_TYPE_LABELS[doc.docType ?? 'markdown']}</span>
                    {doc.linkedNoteIds && doc.linkedNoteIds.length > 0 && (
                      <span className="flex items-center gap-0.5">
                        <ListTodo className="h-3 w-3" /> {doc.linkedNoteIds.length}
                      </span>
                    )}
                    {doc.annotationCount ? (
                      <span className="flex items-center gap-0.5">
                        <MessageSquareText className="h-3 w-3" /> {doc.annotationCount}
                      </span>
                    ) : null}
                  </div>
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {doc.tags.slice(0, 3).map((t) => (
                        <span key={t} className="badge badge-primary">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 标签云 */}
      {allTags.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-[var(--nw-foreground)]">标签</h2>
          <div className="flex flex-wrap gap-2">
            {allTags.map((tag) => (
              <span key={tag} className="badge badge-primary">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function QuickCreateCard({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof FileText
  label: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="surface-elevated flex items-center gap-3 p-3 text-left transition-all hover:bg-[var(--nw-surface-2)] hover:shadow-[var(--shadow-md)]"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-[var(--nw-accent-soft)] text-[var(--nw-primary)]">
        <Icon className="h-4 w-4" />
      </div>
      <span className="text-sm font-medium text-[var(--nw-foreground)]">{label}</span>
      <Plus className="ml-auto h-4 w-4 text-[var(--nw-muted-foreground)]" />
    </button>
  )
}
