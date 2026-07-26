import { useState } from 'react'
import { FolderArchive, FileCode, FileArchive, Loader2 } from 'lucide-react'
import { Modal } from './Modal'
import { cn } from '../lib/utils'

// REQ-210 导出整个知识库弹窗：选择格式 + 可选元数据 + 进度提示。
interface ExportKbDialogProps {
  open: boolean
  kbId: string | null
  kbName: string
  onClose: () => void
}

type Format = 'markdown-folder' | 'html-site' | 'zip'

const FORMATS: { value: Format; label: string; desc: string; icon: typeof FileCode }[] = [
  { value: 'markdown-folder', label: 'Markdown 文件夹', desc: '保持文档层级，含资源与索引 README', icon: FolderArchive },
  { value: 'html-site', label: 'HTML 站点', desc: '每篇文档独立 HTML + 索引页与导航', icon: FileCode },
  { value: 'zip', label: 'ZIP 压缩包', desc: 'Markdown 文件夹打包，便于分享', icon: FileArchive }
]

export function ExportKbDialog({ open, kbId, kbName, onClose }: ExportKbDialogProps) {
  const [format, setFormat] = useState<Format>('markdown-folder')
  const [includeAnnotations, setIncludeAnnotations] = useState(true)
  const [includeComments, setIncludeComments] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ count: number; path: string } | null>(null)
  const [error, setError] = useState('')

  if (!open) return null

  const handleExport = async () => {
    if (!kbId) return
    setBusy(true)
    setError('')
    setDone(null)
    try {
      const result = await window.electronAPI.exportKnowledgeBase(kbId, {
        format,
        includeAnnotations,
        includeComments,
        includeHistory
      })
      if (result.success) {
        setDone({ count: result.docCount, path: result.outputPath ?? '' })
      } else if (result.error) {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`导出知识库「${kbName}」`} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <div>
          <div className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">导出格式</div>
          <div className="grid grid-cols-1 gap-2">
            {FORMATS.map((f) => {
              const Icon = f.icon
              const active = format === f.value
              return (
                <button
                  key={f.value}
                  onClick={() => setFormat(f.value)}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                    active
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-ghost-hover)]'
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                  <div className="min-w-0">
                    <div className="font-medium text-[var(--color-foreground)]">{f.label}</div>
                    <div className="text-xs text-[var(--color-muted-foreground)]">{f.desc}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-medium text-[var(--color-muted-foreground)]">包含元数据</div>
          <div className="space-y-1">
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={includeAnnotations} onChange={(e) => setIncludeAnnotations(e.target.checked)} />
              <span>批注</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={includeComments} onChange={(e) => setIncludeComments(e.target.checked)} />
              <span>评论</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" checked={includeHistory} onChange={(e) => setIncludeHistory(e.target.checked)} />
              <span>版本历史（最近 20 条）</span>
            </label>
          </div>
        </div>

        {busy && (
          <div className="flex items-center gap-2 rounded-md bg-[var(--color-ghost)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在导出，请稍候…（弹出文件夹选择后开始）
          </div>
        )}

        {error && <div className="badge badge-danger px-3 py-2 text-xs">{error}</div>}

        {done && (
          <div className="badge badge-success px-3 py-2 text-xs">
            导出完成：共 {done.count} 篇文档，输出位置：{done.path}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">
            关闭
          </button>
          <button
            onClick={handleExport}
            disabled={busy || !kbId}
            className="btn-primary disabled:opacity-50"
          >
            {busy ? '导出中…' : '选择文件夹并导出'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
