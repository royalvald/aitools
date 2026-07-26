import { useEffect, useRef, useState } from 'react'
import { DatabaseZap, Download, FileInput, Upload } from 'lucide-react'

interface DataMenuButtonProps {
  onImport?: () => void
  onExport?: () => void
  /** REQ-209 导入外部文件（.docx/.html/.md/Notion ZIP） */
  onImportExternal?: () => void
  /** 折叠态：仅图标；展开态：图标 + 文案（默认 true） */
  withLabel?: boolean
}

/**
 * 数据工具统一入口：一个按钮，点击弹出下拉菜单（导入数据 / 导出所有数据 / 导入外部文件）。
 * 用于替代侧栏里散落的两个独立导入、导出按钮，集中操作、减少视觉噪声。
 */
export function DataMenuButton({ onImport, onExport, onImportExternal, withLabel = true }: DataMenuButtonProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handlePick = (action: 'import' | 'export' | 'importExternal') => {
    setOpen(false)
    if (action === 'import') onImport?.()
    else if (action === 'export') onExport?.()
    else if (action === 'importExternal') onImportExternal?.()
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={withLabel ? 'btn-ghost' : 'btn-icon'}
        title="数据工具"
      >
        <DatabaseZap className="h-4 w-4" />
        {withLabel && <span>数据</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1.5 w-44 overflow-hidden rounded-lg border border-[var(--color-border)] bg-surface py-1 text-sm shadow-[var(--shadow-md)]">
          <button
            onClick={() => handlePick('importExternal')}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
          >
            <FileInput className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            导入外部文件
          </button>
          <button
            onClick={() => handlePick('import')}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
          >
            <Upload className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            导入数据（还原备份）
          </button>
          <button
            onClick={() => handlePick('export')}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)]"
          >
            <Download className="h-4 w-4 text-[var(--color-muted-foreground)]" />
            导出所有数据（全量备份）
          </button>
        </div>
      )}
    </div>
  )
}
