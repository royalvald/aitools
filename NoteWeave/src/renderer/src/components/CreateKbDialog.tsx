import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Modal } from './Modal'

interface CreateKbDialogProps {
  onClose: () => void
  onCreate: (name: string, category: string) => void
  onMountExternal?: () => void
}

export function CreateKbDialog({ onClose, onCreate, onMountExternal }: CreateKbDialogProps) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onCreate(name.trim(), category.trim())
    onClose()
  }

  return (
    <Modal title="新建知识库" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：项目文档"
            className="input"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">分类</label>
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="例如：工作"
            className="input"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              onMountExternal?.()
              onClose()
            }}
            className="btn-secondary mr-auto"
            title="以本地文件夹作为知识库挂载（REQ-120）"
          >
            <FolderOpen className="h-4 w-4" />
            打开本地文件夹…
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="btn-primary"
          >
            创建
          </button>
        </div>
      </form>
    </Modal>
  )
}
