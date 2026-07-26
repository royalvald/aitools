import { useState } from 'react'
import { Modal } from './Modal'

interface CreateNoteGroupDialogProps {
  onClose: () => void
  onCreate: (name: string) => void
}

/**
 * 新建分组弹窗（用于创建顶层分组）。
 *
 * 注意：不使用 window.prompt —— Electron 渲染进程默认禁用原生 prompt
 * （调用会静默返回 null），因此改用项目内统一的 Modal 弹窗来收集分组名。
 */
export function CreateNoteGroupDialog({ onClose, onCreate }: CreateNoteGroupDialogProps) {
  const [name, setName] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name.trim())
    onClose()
  }

  return (
    <Modal title="新建分组" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="分组名称，例如：工作、学习"
          className="input"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            取消
          </button>
          <button type="submit" disabled={!name.trim()} className="btn-primary disabled:cursor-not-allowed">
            创建
          </button>
        </div>
      </form>
    </Modal>
  )
}
