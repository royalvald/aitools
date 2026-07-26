import { useState } from 'react'
import { CheckCircle2, XCircle, ImageOff } from 'lucide-react'
import { Modal } from './Modal'
import type { ImportExternalResult } from '../types'

// REQ-209 导入外部文件报告弹窗：显示成功数、失败文件、跳过的图片。
interface ImportExternalDialogProps {
  // 若 result 为 null 且未在导入中，组件不渲染
  result: ImportExternalResult | null
  onClose: () => void
}

export function ImportExternalDialog({ result, onClose }: ImportExternalDialogProps) {
  if (!result) return null
  const failedCount = result.failed.length
  const skippedCount = result.skippedImages.length

  return (
    <Modal title="导入外部文件报告" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />
          <span>
            成功导入 <strong className="text-[var(--color-success)]">{result.imported.length}</strong> 个文档
          </span>
        </div>

        {result.imported.length > 0 && (
          <ul className="max-h-40 overflow-y-auto rounded-md bg-[var(--color-ghost)] p-2 text-xs">
            {result.imported.map((name, i) => (
              <li key={i} className="truncate text-[var(--color-foreground)]">
                · {name}
              </li>
            ))}
          </ul>
        )}

        {failedCount > 0 && (
          <div>
            <div className="flex items-center gap-2 text-[var(--color-danger)]">
              <XCircle className="h-5 w-5" />
              <span>
                失败 <strong>{failedCount}</strong> 个文件
              </span>
            </div>
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-md bg-[var(--color-danger-soft)] p-2 text-xs">
              {result.failed.map((f, i) => (
                <li key={i} className="text-[var(--color-danger)]">
                  · {f.file}：{f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {skippedCount > 0 && (
          <div>
            <div className="flex items-center gap-2 text-[var(--color-warning)]">
              <ImageOff className="h-5 w-5" />
              <span>
                跳过 <strong>{skippedCount}</strong> 张图片
              </span>
            </div>
            <ul className="mt-1 max-h-32 overflow-y-auto rounded-md bg-[var(--color-warning-soft)] p-2 text-xs">
              {result.skippedImages.map((name, i) => (
                <li key={i} className="text-[var(--color-warning)]">
                  · {name}
                </li>
              ))}
            </ul>
          </div>
        )}

        {failedCount === 0 && skippedCount === 0 && (
          <p className="text-xs text-[var(--color-muted-foreground)]">全部文件导入成功，无失败或跳过的图片。</p>
        )}

        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="btn-primary">
            完成
          </button>
        </div>
      </div>
    </Modal>
  )
}

// 触发导入并显示报告的包装组件（供菜单/按钮直接调用）
export function useImportExternal() {
  const [result, setResult] = useState<ImportExternalResult | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (kbId: string | null) => {
    setBusy(true)
    try {
      const r = await window.electronAPI.importExternalFiles(kbId)
      if (r.success) setResult(r)
    } finally {
      setBusy(false)
    }
  }

  return { result, busy, run, clear: () => setResult(null) }
}
