import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'
import type { KnowledgeBaseDocSummary, KnowledgeBaseSummary, NoteSummary, TodoTargetType } from '../types'

interface CreateTodoDialogProps {
  onClose: () => void
  onCreate: (
    title: string,
    detail: string,
    targetType: TodoTargetType | null,
    targetId: string | null,
    kbId?: string
  ) => void
  /**
   * 预设关联：从文档/便签工具栏进入时锁定关联对象，对话框不显示关联选择区。
   * 不传则进入自由模式，允许用户选择关联便签/文档/或不关联。
   */
  presetTarget?: { targetType: TodoTargetType; targetId: string; kbId?: string; label: string }
}

type LinkMode = 'none' | 'note' | 'kbDoc'

export function CreateTodoDialog({ onClose, onCreate, presetTarget }: CreateTodoDialogProps) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const titleRef = useRef<HTMLInputElement>(null)

  // 自由模式下的关联选择
  const [linkMode, setLinkMode] = useState<LinkMode>('none')
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([])
  const [docs, setDocs] = useState<KnowledgeBaseDocSummary[]>([])
  const [selectedKbId, setSelectedKbId] = useState('')
  const [selectedDocId, setSelectedDocId] = useState('')
  const [isLoadingTargets, setIsLoadingTargets] = useState(false)

  const isLocked = !!presetTarget

  // 对话框打开 / 关联对象加载完成时，延迟聚焦标题输入框。
  // Electron 的 Chromium 下 React 的 autoFocus 偶发不生效（输入框渲染出来却没拿到焦点，
  // 表现为「打字没反应」）；自由模式异步加载完关联对象后还会再次重排，更易丢焦。
  // 这里用 rAF 在浏览器完成本次布局后再 focus，确保输入框稳定获得焦点。
  useEffect(() => {
    const id = requestAnimationFrame(() => titleRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [isLocked, isLoadingTargets])

  useEffect(() => {
    if (isLocked) return
    let cancelled = false
    async function load() {
      setIsLoadingTargets(true)
      const noteList = await window.electronAPI.listNotes()
      const kbList = await window.electronAPI.listKnowledgeBases()
      if (cancelled) return
      setNotes(noteList)
      setKbs(kbList)
      setSelectedNoteId(noteList[0]?.id ?? '')
      setSelectedKbId(kbList[0]?.id ?? '')
      setIsLoadingTargets(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [isLocked])

  // 选中的 KB 变化时，加载其文档列表
  useEffect(() => {
    if (isLocked || linkMode !== 'kbDoc' || !selectedKbId) return
    let cancelled = false
    async function loadDocs() {
      const docList = await window.electronAPI.listKbDocs(selectedKbId)
      if (cancelled) return
      setDocs(docList)
      setSelectedDocId(docList[0]?.id ?? '')
    }
    loadDocs()
    return () => {
      cancelled = true
    }
  }, [isLocked, linkMode, selectedKbId])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    if (isLocked && presetTarget) {
      onCreate(title.trim(), detail.trim(), presetTarget.targetType, presetTarget.targetId, presetTarget.kbId)
      onClose()
      return
    }

    if (linkMode === 'note' && selectedNoteId) {
      onCreate(title.trim(), detail.trim(), 'note', selectedNoteId)
    } else if (linkMode === 'kbDoc' && selectedDocId) {
      onCreate(title.trim(), detail.trim(), 'kbDoc', selectedDocId, selectedKbId)
    } else {
      onCreate(title.trim(), detail.trim(), null, null)
    }
    onClose()
  }

  return (
    <Modal title={isLocked ? '新建待办' : '新建待办任务'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">标题</label>
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：整理本周会议纪要"
            className="input"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">详情/备注（选填）</label>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="补充说明…"
            rows={3}
            className="input resize-none"
          />
        </div>

        {/* 关联对象区 */}
        {isLocked ? (
          <div className="surface-inset px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
            关联到：<span className="text-[var(--color-foreground)]">{presetTarget?.label}</span>
          </div>
        ) : isLoadingTargets ? (
          <div className="py-2 text-center text-sm text-[var(--color-muted-foreground)]">加载关联对象…</div>
        ) : (
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">关联对象（选填）</label>
            <div className="mb-2 flex items-center gap-3">
              {(
                [
                  { key: 'none' as const, label: '不关联' },
                  { key: 'note' as const, label: '笔记' },
                  { key: 'kbDoc' as const, label: '文档' }
                ]
              ).map((opt) => (
                <label
                  key={opt.key}
                  className={`flex cursor-pointer items-center gap-1 text-sm ${
                    linkMode === opt.key ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted-foreground)]'
                  }`}
                >
                  <input
                    type="radio"
                    name="linkMode"
                    value={opt.key}
                    checked={linkMode === opt.key}
                    onChange={() => setLinkMode(opt.key)}
                    className="h-3.5 w-3.5"
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            {linkMode === 'note' && (
              <>
                {notes.length === 0 ? (
                  <p className="text-xs text-[var(--color-muted-foreground)]">暂无笔记</p>
                ) : (
                  <select
                    value={selectedNoteId}
                    onChange={(e) => setSelectedNoteId(e.target.value)}
                    className="input"
                  >
                    {notes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.title || '无标题'}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            {linkMode === 'kbDoc' && (
              <div className="flex flex-col gap-2">
                {kbs.length === 0 ? (
                  <p className="text-xs text-[var(--color-muted-foreground)]">暂无知识库，请先创建知识库与文档。</p>
                ) : (
                  <>
                    <select
                      value={selectedKbId}
                      onChange={(e) => setSelectedKbId(e.target.value)}
                      className="input"
                    >
                      {kbs.map((kb) => (
                        <option key={kb.id} value={kb.id}>
                          {kb.name}（{kb.category}）
                        </option>
                      ))}
                    </select>
                    <select
                      value={selectedDocId}
                      onChange={(e) => setSelectedDocId(e.target.value)}
                      disabled={docs.length === 0}
                      className="input disabled:opacity-50"
                    >
                      {docs.length === 0 ? (
                        <option value="">该知识库下暂无文档</option>
                      ) : (
                        docs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name || '未命名文档'}
                          </option>
                        ))
                      )}
                    </select>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="btn-primary"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  )
}
