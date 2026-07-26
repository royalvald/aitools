import { useState, type ReactNode } from 'react'
import {
  ChevronRight,
  FileText,
  MessageSquareText,
  Network,
  Plus,
  Trash2
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { KnowledgeBaseDocSummary } from '../types'

interface KbDocTreeProps {
  docs: KnowledgeBaseDocSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: (parentId?: string | null) => void
  onDelete: (id: string) => void
  /** REQ-006：将 docId 移动到新父节点下（null=顶层）。返回是否成功。 */
  onMove: (docId: string, parentId: string | null) => Promise<boolean>
  /** REQ-006：删除含子文档的父节点时询问处理方式。cascade=true 删除子孙。 */
  onDeleteWithChildren?: (id: string) => Promise<void>
}

interface TreeNode {
  doc: KnowledgeBaseDocSummary
  children: TreeNode[]
}

// 将扁平 docs（含 parentId）构建为树。
function buildTree(docs: KnowledgeBaseDocSummary[]): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  docs.forEach((d) => byId.set(d.id, { doc: d, children: [] }))
  const roots: TreeNode[] = []
  // 保持 order 升序
  const sorted = [...docs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const d of sorted) {
    const node = byId.get(d.id)!
    if (d.parentId && byId.has(d.parentId)) {
      byId.get(d.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

// 缩进层数上限：超过后不再加深，避免深层文档把标题挤出窄列。
const MAX_INDENT_DEPTH = 8

const DOC_TYPE_ICONS: Record<string, typeof FileText> = {
  mindmap: Network,
  markdown: FileText
}

/**
 * 语雀式常驻文档树（窄列紧凑单行）：
 * - 支持展开/折叠（chevron + aria-expanded），默认全部展开；
 * - 缩进深度封顶 MAX_INDENT_DEPTH；
 * - 保留拖拽移动（拖到节点上变为子文档、拖到底部区域变为顶层）与悬浮操作（新建子文档/删除）。
 */
export function KbDocTree({
  docs,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  onMove,
  onDeleteWithChildren
}: KbDocTreeProps) {
  const tree = buildTree(docs)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // 折叠的节点 id 集合（默认全部展开）
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())

  const toggleCollapsed = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleDelete = (doc: KnowledgeBaseDocSummary) => {
    const hasChildren = docs.some((d) => d.parentId === doc.id)
    if (hasChildren && onDeleteWithChildren) {
      void onDeleteWithChildren(doc.id)
    } else {
      onDelete(doc.id)
    }
  }

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    const doc = node.doc
    const isActive = doc.id === selectedId
    const isDragOver = dragOverId === doc.id
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsedIds.has(doc.id)
    const TypeIcon = DOC_TYPE_ICONS[doc.docType ?? 'markdown'] ?? FileText

    return (
      <div key={doc.id}>
        <div
          draggable
          onDragStart={(e) => {
            setDragId(doc.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragEnd={() => {
            setDragId(null)
            setDragOverId(null)
          }}
          onDragOver={(e) => {
            if (dragId && dragId !== doc.id) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDragOverId(doc.id)
            }
          }}
          onDragLeave={() => setDragOverId((prev) => (prev === doc.id ? null : prev))}
          onDrop={(e) => {
            if (!dragId || dragId === doc.id) return
            e.preventDefault()
            setDragOverId(null)
            void onMove(dragId, doc.id)
            setDragId(null)
          }}
          onClick={() => onSelect(doc.id)}
          className={cn(
            'group relative flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 text-left transition-colors',
            isActive
              ? 'bg-[var(--nw-surface)] shadow-[inset_3px_0_0_var(--nw-primary)] dark:bg-[var(--nw-surface-3)]'
              : isDragOver
                ? 'bg-[var(--nw-accent-soft)]/60'
                : 'hover:bg-[var(--nw-ghost-hover)]'
          )}
          style={{ paddingLeft: 4 + Math.min(depth, MAX_INDENT_DEPTH) * 14 }}
        >
          {/* 展开/折叠 chevron（仅有子文档时可用，否则占位对齐） */}
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={!isCollapsed}
              title={isCollapsed ? '展开' : '折叠'}
              onClick={(e) => {
                e.stopPropagation()
                toggleCollapsed(doc.id)
              }}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-border)] hover:text-[var(--color-foreground)]"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 transition-transform', !isCollapsed && 'rotate-90')}
              />
            </button>
          ) : (
            <span className="w-4 flex-shrink-0" />
          )}

          <TypeIcon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--nw-muted-foreground)]" />

          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              isActive
                ? 'font-medium text-[var(--nw-primary)]'
                : 'text-[var(--color-foreground)]'
            )}
          >
            {doc.name || '未命名文档'}
          </span>

          {doc.annotationCount != null && doc.annotationCount > 0 && (
            <span className="flex flex-shrink-0 items-center gap-0.5 text-[11px] text-[var(--color-muted-foreground)]">
              <MessageSquareText className="h-3 w-3" />
              {doc.annotationCount}
            </span>
          )}

          {/* 悬浮操作：新建子文档 / 删除 */}
          <div className="flex flex-shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              title="新建子文档"
              onClick={(e) => {
                e.stopPropagation()
                onCreate(doc.id)
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--nw-muted-foreground)] hover:bg-[var(--nw-ghost-hover)] hover:text-[var(--color-foreground)]"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="删除"
              onClick={(e) => {
                e.stopPropagation()
                handleDelete(doc)
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--nw-muted-foreground)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {hasChildren && !isCollapsed && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {docs.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-[var(--color-muted-foreground)]">
          <p>暂无文档</p>
          <button
            onClick={() => onCreate(null)}
            className="rounded-md text-[var(--color-primary)] hover:underline"
          >
            创建第一篇文档
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {tree.map((node) => renderNode(node, 0))}
          {/* 底部置顶拖放区：拖到此处提升为顶层 */}
          <div
            className="mt-2 rounded-md border border-dashed border-[var(--color-border)] py-2 text-center text-[11px] text-[var(--color-muted-foreground)]"
            onDragOver={(e) => {
              if (dragId) e.preventDefault()
            }}
            onDrop={(e) => {
              if (!dragId) return
              e.preventDefault()
              void onMove(dragId, null)
              setDragId(null)
            }}
          >
            拖到此处变为顶层文档
          </div>
        </div>
      )}
    </div>
  )
}
