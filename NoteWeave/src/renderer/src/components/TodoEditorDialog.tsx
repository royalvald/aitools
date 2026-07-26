import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import type { Todo } from '../types'

interface TodoEditorDialogProps {
  todo: Todo
  onClose: () => void
  onSave: (todo: Todo) => void
}

export function TodoEditorDialog({ todo, onClose, onSave }: TodoEditorDialogProps) {
  const [title, setTitle] = useState(todo.title)
  const [detail, setDetail] = useState(todo.detail)

  useEffect(() => {
    setTitle(todo.title)
    setDetail(todo.detail)
  }, [todo])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    onSave({ ...todo, title: title.trim(), detail: detail.trim() })
    onClose()
  }

  return (
    <Modal title="编辑待办" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">标题</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：整理本周会议纪要"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">详情/备注（选填）</label>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="补充说明…"
            rows={4}
            className="input resize-none"
          />
        </div>
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
            保存
          </button>
        </div>
      </form>
    </Modal>
  )
}
