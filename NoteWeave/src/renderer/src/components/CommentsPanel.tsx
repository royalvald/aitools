import { useEffect, useState } from 'react'
import { MessageCircle, Plus, Trash2 } from 'lucide-react'
import { useConfirm } from './ConfirmDialog'
import { formatDateTime } from '../lib/utils'
import type { KbDocComment } from '../types'

/**
 * 页面评论（问答）：针对单个文档记录问答——顶层条目为「问题」，其回复为「回答」。
 * 数据层复用原评论存储（新条目 paragraphId 固定为 'page'），旧段落评论数据照常展示。
 */
interface CommentsPanelProps {
  kbId: string
  docId: string
  onMutation?: () => void
  /** 嵌入统一右侧栏（「讨论」面板）时：占满容器宽度、无边框 */
  embedded?: boolean
}

export function CommentsPanel({ kbId, docId, onMutation, embedded }: CommentsPanelProps) {
  const confirm = useConfirm()
  const [comments, setComments] = useState<KbDocComment[]>([])
  const [loading, setLoading] = useState(true)
  const [answerFor, setAnswerFor] = useState<string | null>(null)
  const [answerText, setAnswerText] = useState('')
  const [editingReply, setEditingReply] = useState<{ commentId: string; replyId: string } | null>(null)
  const [editReplyText, setEditReplyText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [adding, setAdding] = useState(false)
  const [newContent, setNewContent] = useState('')

  const reload = () => {
    setLoading(true)
    window.electronAPI
      .listComments(kbId, docId)
      .then(setComments)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kbId, docId])

  const handleAdd = async () => {
    const content = newContent.trim()
    if (!content) return
    await window.electronAPI.createComment(kbId, docId, 'page', content)
    setAdding(false)
    setNewContent('')
    reload()
    onMutation?.()
  }

  const handleAnswer = async (comment: KbDocComment) => {
    const text = answerText.trim()
    if (!text) return
    await window.electronAPI.addCommentReply(comment, text)
    setAnswerFor(null)
    setAnswerText('')
    reload()
    onMutation?.()
  }

  const handleDelete = async (c: KbDocComment) => {
    const ok = await confirm({
      title: '删除问题',
      description: '确定要删除这个问题及其全部回答吗？',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    await window.electronAPI.deleteComment(kbId, docId, c.id)
    reload()
    onMutation?.()
  }

  const handleSaveEdit = async (c: KbDocComment) => {
    const text = editText.trim()
    if (!text) return
    await window.electronAPI.updateComment({ ...c, content: text })
    setEditingId(null)
    reload()
    onMutation?.()
  }

  const handleSaveReplyEdit = async (c: KbDocComment, replyId: string) => {
    const text = editReplyText.trim()
    if (!text) return
    await window.electronAPI.updateCommentReply(c, replyId, text)
    setEditingReply(null)
    setEditReplyText('')
    reload()
    onMutation?.()
  }

  return (
    <div
      className={
        embedded
          ? 'flex h-full w-full flex-col bg-[var(--color-surface)]'
          : 'flex w-72 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]'
      }
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold text-[var(--color-foreground)]">
        <MessageCircle className="h-4 w-4" />
        页面评论
        <span className="ml-1 rounded-full bg-[var(--color-ghost)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--color-muted-foreground)]">
          {comments.length}
        </span>
        <button
          onClick={() => setAdding((v) => !v)}
          className="btn-icon ml-auto"
          title="提问"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {adding && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-ghost)] p-2">
          <textarea
            autoFocus
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="记录一个关于本文档的问题…"
            rows={2}
            className="input px-2 py-1 text-xs"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              onClick={() => {
                setAdding(false)
                setNewContent('')
              }}
              className="text-[11px] text-[var(--color-muted-foreground)]"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={!newContent.trim()}
              className="btn-primary px-2 py-0.5 text-[11px]"
            >
              发布
            </button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="px-2 py-3 text-xs text-[var(--color-muted-foreground)]">加载中…</div>
        ) : comments.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--color-muted-foreground)]">
            暂无问答。点击右上角 + 记录本文档的问题与解答。
          </div>
        ) : (
          comments.map((c) => (
            <div
              key={c.id}
              className="mb-2 surface-elevated p-2.5"
            >
              <div className="mb-1 flex items-start gap-1.5">
                <span className="mt-0.5 shrink-0 rounded bg-[var(--nw-accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--nw-primary)]">
                  问
                </span>
                {editingId === c.id ? (
                  <div className="min-w-0 flex-1">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                      className="input px-2 py-1 text-xs"
                    />
                    <div className="mt-1 flex gap-2">
                      <button
                        onClick={() => handleSaveEdit(c)}
                        className="btn-primary px-2 py-0.5 text-[11px]"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-[11px] text-[var(--color-muted-foreground)]"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="min-w-0 flex-1 text-sm text-[var(--color-foreground)]">{c.content}</p>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => {
                      setEditingId(c.id)
                      setEditText(c.content)
                    }}
                    className="text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleDelete(c)}
                    className="text-[var(--color-muted-foreground)] hover:text-[var(--color-danger)]"
                    title="删除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="pl-7 text-[10px] text-[var(--color-muted-foreground)]">
                {formatDateTime(c.createdAt)}
              </div>

              {c.replies && c.replies.length > 0 && (
                <div className="mt-2 space-y-1.5 border-l-2 border-[var(--color-border)] pl-2">
                  {c.replies.map((r) => (
                    <div key={r.id} className="flex items-start gap-1.5 text-xs">
                      <span className="mt-0.5 shrink-0 rounded bg-[var(--color-ghost)] px-1 py-0.5 text-[10px] text-[var(--color-muted-foreground)]">
                        答
                      </span>
                      {editingReply?.commentId === c.id && editingReply.replyId === r.id ? (
                        <div className="min-w-0 flex-1">
                          <input
                            autoFocus
                            value={editReplyText}
                            onChange={(e) => setEditReplyText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveReplyEdit(c, r.id)
                              if (e.key === 'Escape') setEditingReply(null)
                            }}
                            className="input px-2 py-1 text-xs"
                          />
                          <div className="mt-1 flex gap-2">
                            <button
                              onClick={() => handleSaveReplyEdit(c, r.id)}
                              disabled={!editReplyText.trim()}
                              className="btn-primary px-2 py-0.5 text-[11px]"
                            >
                              保存
                            </button>
                            <button
                              onClick={() => setEditingReply(null)}
                              className="text-[11px] text-[var(--color-muted-foreground)]"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="min-w-0 flex-1 text-[var(--color-foreground)]">{r.content}</span>
                      )}
                      <button
                        onClick={() => {
                          setEditingReply({ commentId: c.id, replyId: r.id })
                          setEditReplyText(r.content)
                        }}
                        className="shrink-0 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
                      >
                        编辑
                      </button>
                      <button
                        onClick={async () => {
                          await window.electronAPI.deleteCommentReply(c, r.id)
                          reload()
                        }}
                        className="shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-danger)]"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {answerFor === c.id ? (
                <div className="mt-2 pl-7">
                  <input
                    autoFocus
                    value={answerText}
                    onChange={(e) => setAnswerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAnswer(c)
                      if (e.key === 'Escape') setAnswerFor(null)
                    }}
                    placeholder="写下回答…"
                    className="input px-2 py-1 text-xs"
                  />
                </div>
              ) : (
                <button
                  onClick={() => {
                    setAnswerFor(c.id)
                    setAnswerText('')
                  }}
                  className="mt-1 pl-7 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-accent)]"
                >
                  回答
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
