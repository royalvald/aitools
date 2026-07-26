import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import type { KnowledgeBaseSummary } from '../types'

interface CreateKbDocDialogProps {
  onClose: () => void
  onCreate: (kbId: string, name: string) => void
}

export function CreateKbDocDialog({ onClose, onCreate }: CreateKbDocDialogProps) {
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([])
  const [selectedKbId, setSelectedKbId] = useState('')
  const [name, setName] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const list = await window.electronAPI.listKnowledgeBases()
      if (!cancelled) {
        setKbs(list)
        setSelectedKbId(list[0]?.id ?? '')
        setIsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedKbId) return
    onCreate(selectedKbId, name.trim())
    onClose()
  }

  return (
    <Modal title="新建知识库文档并关联" onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {isLoading ? (
          <div className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">加载中…</div>
        ) : kbs.length === 0 ? (
          <div className="py-4 text-center text-sm text-[var(--color-muted-foreground)]">暂无可用的知识库，请先创建知识库。</div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">所属知识库</label>
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
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--color-foreground)]">文档名称</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：接口文档"
                className="input"
                autoFocus
              />
            </div>
          </>
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
            disabled={!selectedKbId}
            className="btn-primary"
          >
            创建并关联
          </button>
        </div>
      </form>
    </Modal>
  )
}
