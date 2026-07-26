import { useState } from 'react'
import { CornerDownRight, Pencil, Trash2, MessageSquareText } from 'lucide-react'
import type { KbDocAnnotation } from '../types'
import { getAnnotationStatus } from '../lib/annotation'
import { formatDate } from '../lib/utils'

interface AnnotationPanelProps {
  annotations: KbDocAnnotation[]
  content: string
  onSelect: (annotation: KbDocAnnotation) => void
  onEdit: (annotation: KbDocAnnotation) => void
  onDelete: (annotation: KbDocAnnotation) => void
  onAddReply?: (annotation: KbDocAnnotation, content: string) => Promise<KbDocAnnotation> | void
  onDeleteReply?: (annotation: KbDocAnnotation, replyId: string) => Promise<KbDocAnnotation> | void
  /** 嵌入统一右侧栏（tab 容器）时：占满容器宽度、无边框与自有标题栏 */
  embedded?: boolean
}

/**
 * 右侧批注面板。按文档出现顺序（startOffset 升序）展示。
 * 状态标注：relocated → 「⚠ 位置可能已变动」；invalid → 条目置灰 + 「原文已修改，定位失效」。
 * REQ-015：每条批注下支持多回复（讨论流）。
 */
export function AnnotationPanel({ annotations, content, onSelect, onEdit, onDelete, onAddReply, onDeleteReply, embedded }: AnnotationPanelProps) {
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({})

  return (
    <div
      className={
        embedded
          ? 'flex h-full min-h-0 w-full flex-col bg-[var(--color-surface)]'
          : 'flex h-full min-h-0 w-80 flex-shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]'
      }
    >
      {!embedded && (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-3">
          <MessageSquareText className="h-4 w-4 text-[var(--color-muted-foreground)]" />
          <span className="text-sm font-semibold text-[var(--color-foreground)]">批注</span>
          <span className="text-xs text-[var(--color-muted-foreground)]">({annotations.length})</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {annotations.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-[var(--color-muted-foreground)]">
              <MessageSquareText className="h-8 w-8 opacity-40" />
              <p>暂无批注</p>
              <p className="text-xs">在预览模式下选中文字，右键即可添加批注</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {annotations.map((annotation) => {
                const { status } = getAnnotationStatus(annotation, content)
                const invalid = status === 'invalid'
                const relocated = status === 'relocated'
                const textPreview =
                  annotation.text.length > 50 ? `${annotation.text.slice(0, 50)}…` : annotation.text

                return (
                  <li
                    key={annotation.id}
                    className={`group rounded-md border border-[var(--color-border)] p-2.5 transition-colors ${
                      invalid ? 'bg-[var(--color-surface-2)] opacity-70' : 'bg-[var(--color-surface)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]'
                    }`}
                  >
                    <div
                      className={`cursor-pointer ${invalid ? '' : 'hover:text-[var(--color-primary)]'}`}
                      onClick={() => !invalid && onSelect(annotation)}
                    >
                      <div className="mb-1 line-clamp-2 rounded bg-[var(--color-warning-soft)] px-2 py-1 text-xs text-[var(--color-muted-foreground)]">
                        {textPreview}
                      </div>
                      <div className="text-sm text-[var(--color-foreground)]">{annotation.content}</div>
                      <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">{formatDate(annotation.updatedAt)}</div>
                      {relocated && (
                        <div className="mt-1 text-xs text-[var(--color-warning)]">⚠ 位置可能已变动</div>
                      )}
                      {invalid && (
                        <div className="mt-1 text-xs text-[var(--color-muted-foreground)]">原文已修改，定位失效</div>
                      )}
                    </div>
                    <div className="mt-1.5 flex justify-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        onClick={() => onEdit(annotation)}
                        className="btn-icon"
                        title="编辑"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => onDelete(annotation)}
                        className="btn-icon"
                        title="删除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* REQ-015 回复列表 */}
                    {onAddReply && (
                      <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
                        {(annotation.replies ?? []).map((reply) => (
                          <div key={reply.id} className="group/reply flex items-start gap-1.5 py-1 pl-1">
                            <CornerDownRight className="mt-0.5 h-3 w-3 flex-shrink-0 text-[var(--color-muted-foreground)]/60" />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs text-[var(--color-foreground)]">{reply.content}</div>
                              <div className="text-[10px] text-[var(--color-muted-foreground)]">{formatDate(reply.createdAt)}</div>
                            </div>
                            {onDeleteReply && (
                              <button
                                onClick={() => onDeleteReply(annotation, reply.id)}
                                className="btn-icon opacity-0 group-hover/reply:opacity-100"
                                title="删除回复"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        ))}
                        <div className="mt-1 flex items-center gap-1">
                          <input
                            value={replyDraft[annotation.id] ?? ''}
                            onChange={(e) =>
                              setReplyDraft((prev) => ({ ...prev, [annotation.id]: e.target.value }))
                            }
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter' && (replyDraft[annotation.id] ?? '').trim()) {
                                e.preventDefault()
                                await onAddReply(annotation, replyDraft[annotation.id].trim())
                                setReplyDraft((prev) => ({ ...prev, [annotation.id]: '' }))
                              }
                            }}
                            placeholder="回复…（回车发送）"
                            className="input min-w-0 flex-1 px-2 py-1 text-xs"
                          />
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
    </div>
  )
}
