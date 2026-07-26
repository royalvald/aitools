import { useState } from 'react'
import { Modal } from './Modal'
import type { NoteGroup } from '../types'

interface CreateNoteDialogProps {
  groups: NoteGroup[]
  defaultGroupId?: string | null
  onClose: () => void
  onCreate: (title: string, groupId: string | null) => void
}

export function CreateNoteDialog({ groups, defaultGroupId = null, onClose, onCreate }: CreateNoteDialogProps) {
  const [title, setTitle] = useState('')
  const [groupId, setGroupId] = useState<string>(defaultGroupId ?? '')

  const topLevel = groups.filter((g) => g.parentId === null)
  const childOf = (parentId: string) => groups.filter((g) => g.parentId === parentId)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onCreate(title.trim(), groupId === '' ? null : groupId)
    onClose()
  }

  return (
    <Modal title="新建笔记" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">标题</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：下午三点开会"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">所属分组</label>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="input"
          >
            <option value="">未分类</option>
            {topLevel.map((parent) => (
              <optgroup label={parent.name} key={parent.id}>
                <option value={parent.id}>{parent.name}</option>
                {childOf(parent.id).map((child) => (
                  <option value={child.id} key={child.id}>
                    {parent.name} / {child.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
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
            className="btn-primary"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  )
}
