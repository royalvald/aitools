import { useEffect, useState } from 'react'
import { FileText, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { cn } from '../lib/utils'
import type { TemplateDoc } from '../types'

interface TemplatePickerDialogProps {
  onClose: () => void
  /** 选择模板后回调其 content（空字符串表示空白文档）。 */
  onSelect: (content: string) => void
  /** 选择后将当前内容保存为模板（可选入口，通常在编辑器内提供）。 */
  onSaveAsTemplate?: (name: string, content: string) => Promise<void>
}

// REQ-011 文档模板选择：新建文档时弹出，可从内置/自定义模板选择。
export function TemplatePickerDialog({ onClose, onSelect }: TemplatePickerDialogProps) {
  const confirm = useConfirm()
  const [templates, setTemplates] = useState<TemplateDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.listTemplates().then((t) => {
      setTemplates(t)
      // 默认选中「空白文档」
      const blank = t.find((x) => x.id === 'builtin-blank')
      setSelectedId(blank?.id ?? (t[0]?.id ?? null))
      setLoading(false)
    })
  }, [])

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: '删除模板',
      description: '确定删除该自定义模板吗？',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const deleted = await window.electronAPI.deleteTemplate(id)
    if (deleted) {
      setTemplates((prev) => prev.filter((t) => t.id !== id))
    }
  }

  const handleConfirm = () => {
    const selected = templates.find((t) => t.id === selectedId)
    onSelect(selected?.content ?? '')
  }

  return (
    <Modal title="选择文档模板" onClose={onClose}>
      {loading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">加载模板…</div>
      ) : (
        <>
          <div className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => setSelectedId(tpl.id)}
                className={cn(
                  'group relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                  selectedId === tpl.id
                    ? 'border-[var(--color-primary)] bg-[var(--nw-accent-soft)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--nw-ghost-hover)]'
                )}
              >
                <FileText className="h-5 w-5 text-[var(--color-muted-foreground)]" />
                <div className="text-sm font-medium text-[var(--color-foreground)]">{tpl.name}</div>
                {tpl.builtin ? (
                  <span className="text-[10px] text-[var(--color-muted-foreground)]">内置</span>
                ) : (
                  <span className="text-[10px] text-[var(--color-muted-foreground)]">自定义</span>
                )}
                {!tpl.builtin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDelete(tpl.id)
                    }}
                    className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--color-muted-foreground)] opacity-0 hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)] focus-visible:opacity-100 group-hover:opacity-100"
                    title="删除模板"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="btn-ghost">
              取消
            </button>
            <button onClick={handleConfirm} className="btn-primary">
              创建文档
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
