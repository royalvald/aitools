import { useMemo, useState } from 'react'
import { useWindowWidth } from '../hooks/useWindowWidth'
import {
  ChevronLeft,
  FileText,
  Home,
  Network,
  Plus
} from 'lucide-react'
import { KbDocTree } from './KbDocTree'
import { KbDocEditor } from './KbDocEditor'
import { KbHome } from './KbHome'
import { MindmapEditor } from './MindmapEditor'
import { EmptyState } from './EmptyState'
import { ErrorBoundary } from './ErrorBoundary'
import type { KnowledgeBase, KnowledgeBaseDoc, KnowledgeBaseDocSummary } from '../types'

interface KbDetailProps {
  kb: KnowledgeBase | null
  docs: KnowledgeBaseDocSummary[]
  selectedDoc: KnowledgeBaseDoc | null
  selectedDocId: string | null
  isLoading: boolean
  /** 返回知识库网格列表 */
  onBackToKbGrid: () => void
  onSelectDoc: (id: string | null) => void
  onCreateDoc: (parentId?: string | null) => void
  /** REQ-212 新建思维导图文档 */
  onCreateMindmapDoc?: () => void
  onChangeDoc: (partial: Partial<KnowledgeBaseDoc>) => void
  onSaveDoc: (doc: KnowledgeBaseDoc) => Promise<KnowledgeBaseDoc>
  onDeleteDoc: (id: string) => void
  /** REQ-006：移动文档层级 */
  onMoveDoc?: (docId: string, parentId: string | null) => Promise<boolean>
  /** REQ-006：级联删除含子文档的父节点 */
  onDeleteDocCascade?: (id: string) => Promise<void>
  onOpenNote?: (noteId: string) => void
  /** 批注增删后刷新文档列表（更新批注数量） */
  onAnnotationsMutation?: () => void
  /** REQ-116 进入演示模式 */
  onPresent?: (content: string) => void
  /** REQ-201 收藏 */
  isFavorite?: (id: string) => boolean
  onToggleFavorite?: (id: string, title: string) => void
}

/**
 * 语雀式知识库详情：左侧 w-72 常驻文档树 + 右侧内容区。
 * 选中文档不再整页替换列表，文档间切换无需返回。
 */
export function KbDetail({
  kb,
  docs,
  selectedDoc,
  selectedDocId,
  isLoading,
  onBackToKbGrid,
  onSelectDoc,
  onCreateDoc,
  onCreateMindmapDoc,
  onChangeDoc,
  onSaveDoc,
  onDeleteDoc,
  onMoveDoc,
  onDeleteDocCascade,
  onOpenNote,
  onAnnotationsMutation,
  onPresent,
  isFavorite,
  onToggleFavorite
}: KbDetailProps) {
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  // 响应式：窗口较窄时目录树列收窄，宽屏恢复正常宽度
  const windowWidth = useWindowWidth()
  const treeWidthClass = windowWidth < 1200 ? 'w-56' : 'w-72'

  // UE-03/05 面包屑：知识库名 + 父级目录链（自根向叶），文档名由 KbDocEditor 自行追加。
  // visited 防御 parentId 成环导致死循环。
  const breadcrumbBase = useMemo(() => {
    if (!kb) return []
    const byId = new Map(docs.map((d) => [d.id, d]))
    const chain: string[] = []
    const visited = new Set<string>()
    let pid = selectedDoc?.parentId ?? null
    while (pid && !visited.has(pid)) {
      visited.add(pid)
      const parent = byId.get(pid)
      if (!parent) break
      chain.unshift(parent.name || '未命名文档')
      pid = parent.parentId ?? null
    }
    return [kb.name, ...chain]
  }, [kb, docs, selectedDoc])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-muted-foreground)]">加载中…</div>
    )
  }

  if (!kb) {
    return (
      <EmptyState
        title="还没有选择知识库"
        description={docs.length === 0 ? '点击左侧“新建”创建一个知识库。' : '点击左侧列表选择一个知识库。'}
      />
    )
  }

  const createItems = [
    { label: 'Markdown 文档', icon: FileText, onClick: () => onCreateDoc(null), visible: true },
    { label: '思维导图', icon: Network, onClick: onCreateMindmapDoc, visible: !!onCreateMindmapDoc }
  ].filter((i) => i.visible)

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧常驻文档树列（宽度随窗口自适应） */}
      <div className={`flex ${treeWidthClass} flex-shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]`}>
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-2 py-2">
          {/* UE-03：返回知识库网格列表 */}
          <button
            onClick={onBackToKbGrid}
            className="btn-icon flex-shrink-0"
            title="返回知识库列表"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => onSelectDoc(null)}
            className="btn-icon flex-shrink-0"
            title="返回知识库首页"
          >
            <Home className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-[var(--color-foreground)]">{kb.name}</div>
            <div className="text-[11px] text-[var(--color-muted-foreground)]">{docs.length} 篇文档</div>
          </div>
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setCreateMenuOpen((v) => !v)}
              className="btn-icon text-[var(--color-primary)]"
              title="新建文档"
            >
              <Plus className="h-4 w-4" />
            </button>
            {createMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setCreateMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-40 surface-elevated py-1 text-sm">
                  {createItems.map((item) => {
                    const Icon = item.icon
                    return (
                      <button
                        key={item.label}
                        onClick={() => {
                          setCreateMenuOpen(false)
                          item.onClick?.()
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface-2)]"
                      >
                        <Icon className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                        {item.label}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <KbDocTree
          docs={docs}
          selectedId={selectedDocId}
          onSelect={(id) => onSelectDoc(id)}
          onCreate={onCreateDoc}
          onDelete={onDeleteDoc}
          onMove={async (docId, parentId) => (onMoveDoc ? onMoveDoc(docId, parentId) : false)}
          onDeleteWithChildren={onDeleteDocCascade}
        />
      </div>

      {/* 右侧内容区：未选文档显示知识库首页，选中后显示对应编辑器 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedDoc ? (
          <KbHome
            kb={kb}
            docs={docs}
            onSelectDoc={(id) => onSelectDoc(id)}
            onCreateDoc={() => onCreateDoc(null)}
            onCreateMindmapDoc={onCreateMindmapDoc}
          />
        ) : (
          <ErrorBoundary>
            {selectedDoc.docType === 'mindmap' ? (
              <MindmapEditor doc={selectedDoc} />
            ) : (
              <KbDocEditor
                doc={selectedDoc}
                breadcrumbBase={breadcrumbBase}
                onChange={onChangeDoc}
                onSave={onSaveDoc}
                onDelete={onDeleteDoc}
                onOpenNote={onOpenNote}
                onAnnotationsMutation={onAnnotationsMutation}
                onPresent={onPresent}
                isFavorite={isFavorite?.(selectedDoc.id)}
                onToggleFavorite={
                  onToggleFavorite ? () => onToggleFavorite(selectedDoc.id, selectedDoc.name || '未命名文档') : undefined
                }
              />
            )}
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}
