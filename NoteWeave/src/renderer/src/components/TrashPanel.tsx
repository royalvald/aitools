import { useEffect, useState } from 'react'
import { FileText, NotebookPen, RotateCcw, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useConfirm } from './ConfirmDialog'
import { formatDate } from '../lib/utils'
import type { TrashSummary } from '../types'

interface TrashPanelProps {
  onClose: () => void
  onRestored: () => void
}

const KIND_LABEL: Record<TrashSummary['kind'], string> = {
  note: '笔记',
  kbDoc: '知识文档',
  knowledgeBase: '知识库'
}

function kindIcon(kind: TrashSummary['kind']) {
  return kind === 'note' ? NotebookPen : FileText
}

// REQ-013 回收站面板：列出已删除项，支持恢复 / 彻底删除 / 清空。
export function TrashPanel({ onClose, onRestored }: TrashPanelProps) {
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<TrashSummary[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    window.electronAPI.listTrash().then((list) => {
      setItems(list)
      setLoading(false)
    })
  }

  useEffect(() => {
    load()
  }, [])

  const handleRestore = async (id: string) => {
    const ok = await window.electronAPI.restoreTrash(id)
    if (ok) {
      onRestored()
      load()
    } else {
      toast.danger('恢复失败：原位置可能已不存在')
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: '彻底删除',
      description: '彻底删除后无法恢复，确定吗？',
      confirmText: '彻底删除',
      danger: true
    })
    if (!ok) return
    await window.electronAPI.deleteTrash(id)
    load()
  }

  const handleEmpty = async () => {
    const ok = await confirm({
      title: '清空回收站',
      description: '清空回收站将永久删除所有项目，确定吗？',
      confirmText: '清空',
      danger: true
    })
    if (!ok) return
    await window.electronAPI.emptyTrash()
    load()
  }

  return (
    <Modal title="回收站" onClose={onClose}>
      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">加载中…</div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">回收站为空</div>
      ) : (
        <>
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs text-[var(--color-muted-foreground)]">共 {items.length} 项</span>
            <button onClick={handleEmpty} className="btn-danger text-xs">
              <Trash2 className="h-3.5 w-3.5" />
              清空回收站
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {items.map((item) => {
              const Icon = kindIcon(item.kind)
              return (
                <li
                  key={item.id}
                  className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2"
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-[var(--color-foreground)]">{item.name}</div>
                    <div className="text-[11px] text-[var(--color-muted-foreground)]">
                      {KIND_LABEL[item.kind]} · 删除于 {formatDate(item.deletedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestore(item.id)}
                    className="rounded p-1.5 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--nw-accent-soft)] hover:text-[var(--color-primary)]"
                    title="恢复"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="rounded p-1.5 text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
                    title="彻底删除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Modal>
  )
}
