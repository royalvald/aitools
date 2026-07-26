import { useEffect, useState } from 'react'
import { ImageIcon, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { useConfirm } from './ConfirmDialog'
import { formatDate } from '../lib/utils'
import type { AssetEntry } from '../types'

interface AssetManagerPanelProps {
  onClose: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// REQ-004 资源管理面板：列出全部图片/附件，可逐个删除或一键清理未引用资源。
export function AssetManagerPanel({ onClose }: AssetManagerPanelProps) {
  const toast = useToast()
  const confirm = useConfirm()
  const [assets, setAssets] = useState<AssetEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    window.electronAPI.listAllAssets().then((list) => {
      setAssets(list)
      setLoading(false)
    })
  }

  useEffect(() => {
    load()
  }, [])

  const handleDelete = async (url: string) => {
    const ok = await confirm({
      title: '删除资源',
      description: '确定删除该资源吗？若文档仍引用它将无法显示。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    await window.electronAPI.deleteAsset(url)
    load()
  }

  const handlePrune = async () => {
    const ok = await confirm({
      title: '清理未引用资源',
      description: '将删除所有未被任何文档引用的资源，确定吗？',
      confirmText: '清理',
      danger: true
    })
    if (!ok) return
    const n = await window.electronAPI.pruneOrphanAssets()
    toast.success(`已清理 ${n} 个未引用资源`)
    load()
  }

  return (
    <Modal title="资源管理（图片 / 附件）" onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs text-[var(--color-muted-foreground)]">共 {assets.length} 个资源</span>
        <button onClick={handlePrune} className="btn-danger text-xs">
          <Trash2 className="h-3.5 w-3.5" />
          清理未引用资源
        </button>
      </div>
      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">加载中…</div>
      ) : assets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-[var(--color-muted-foreground)]">
          <ImageIcon className="h-8 w-8 opacity-40" />
          暂无资源
        </div>
      ) : (
        <ul className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto">
          {assets.map((a) => (
            <li
              key={a.url}
              className="group flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2"
            >
              <ImageIcon className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[var(--color-foreground)]">{a.name}</div>
                <div className="text-[11px] text-[var(--color-muted-foreground)]">
                  {a.scope === 'note' ? '笔记' : '知识库'} · {formatSize(a.size)} · {formatDate(a.createdAt)}
                </div>
              </div>
              <button
                onClick={() => handleDelete(a.url)}
                className="btn-icon opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                title="删除资源"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
