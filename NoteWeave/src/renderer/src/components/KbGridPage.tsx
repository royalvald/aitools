import { FolderInput, Link2, MoreHorizontal, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KnowledgeBaseSummary } from '../types'
import { useConfirm } from './ConfirmDialog'
import { EmptyState } from './EmptyState'

export interface KbGridPageProps {
  kbs: KnowledgeBaseSummary[]
  docCounts: Record<string, number>
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onExportKb: (kbId: string) => void
  onMountExternal: () => void
}

// 名称首字符色块的调色板
const CARD_COLORS = ['#31B97F', '#38A3E0', '#8B7CF6', '#F0A03C', '#E4637C', '#2BB3A8']

// 语雀式知识库列表页：页头 + 卡片网格 + 空态。
export function KbGridPage({
  kbs,
  docCounts,
  onSelect,
  onCreate,
  onDelete,
  onExportKb,
  onMountExternal
}: KbGridPageProps) {
  const confirm = useConfirm()
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 下拉菜单打开时点击外部关闭
  useEffect(() => {
    if (!menuOpenId) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpenId])

  const handleDelete = async (kb: KnowledgeBaseSummary) => {
    const ok = await confirm({
      title: '删除知识库',
      description: `确定要删除知识库「${kb.name}」吗？其中的文档将一并删除，此操作不可撤销。`,
      confirmText: '删除',
      danger: true
    })
    if (ok) onDelete(kb.id)
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 页头 */}
      <div className="flex items-center justify-between border-b border-[var(--nw-border)] px-8 py-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">知识库</h1>
          <span className="text-sm text-muted-foreground">共 {kbs.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={onMountExternal}>
            <FolderInput className="h-4 w-4" />
            <span>挂载外部知识库</span>
          </button>
          <button type="button" className="btn-primary" onClick={onCreate}>
            <Plus className="h-4 w-4" />
            <span>新建知识库</span>
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-8">
        {kbs.length === 0 ? (
          <EmptyState
            title="还没有知识库"
            description="创建第一个知识库，开始沉淀结构化文档"
            actions={[{ label: '新建知识库', onClick: onCreate, variant: 'primary' }]}
          />
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
            {/* 新建卡片 */}
            <button
              type="button"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--nw-border)] py-10 text-[var(--nw-muted-foreground)] transition-colors hover:border-[var(--nw-primary)] hover:text-[var(--nw-primary)]"
              onClick={onCreate}
            >
              <Plus className="h-6 w-6" />
              <span>新建知识库</span>
            </button>

            {kbs.map((kb) => {
              const isExternal = kb.source === 'external'
              const color = CARD_COLORS[kb.name.charCodeAt(0) % CARD_COLORS.length]
              return (
                <div
                  key={kb.id}
                  className="kb-card group relative flex cursor-pointer flex-col gap-3"
                  onClick={() => onSelect(kb.id)}
                >
                  {/* 更多按钮与下拉 */}
                  <button
                    type="button"
                    className="btn-icon absolute right-2 top-2 opacity-0 group-hover:opacity-100"
                    title="更多"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuOpenId((v) => (v === kb.id ? null : kb.id))
                    }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuOpenId === kb.id && (
                    <div
                      ref={menuRef}
                      className="absolute right-2 top-10 z-20 w-36 rounded-lg border border-[var(--nw-border)] bg-surface py-1 text-sm shadow-md"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--nw-ghost-hover)]"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenId(null)
                          onExportKb(kb.id)
                        }}
                      >
                        导出知识库
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-danger transition-colors hover:bg-[var(--nw-ghost-hover)]"
                        onClick={async (e) => {
                          e.stopPropagation()
                          setMenuOpenId(null)
                          await handleDelete(kb)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  )}

                  {/* 顶部行：首字符色块 */}
                  <div className="flex items-center gap-2">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-lg text-base font-semibold text-white"
                      style={{ backgroundColor: color }}
                    >
                      {kb.name.charAt(0) || '库'}
                    </div>
                    {isExternal && (
                      <span className="badge flex items-center gap-1">
                        <Link2 className="h-3 w-3" />
                        外部
                      </span>
                    )}
                  </div>

                  {/* 名称 */}
                  <div className="truncate font-medium" title={kb.name}>
                    {kb.name}
                  </div>

                  {/* 信息行 */}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {kb.category && <span className="badge">{kb.category}</span>}
                    <span>{docCounts[kb.id] ?? 0} 篇文档</span>
                    <span>{new Date(kb.updatedAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
