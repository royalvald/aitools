import { Download, FileCode, FileText, FileType2, FileJson, BookOpen, FileType } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useToast } from './Toast'
import type { KnowledgeBaseDoc, ThemeSummary } from '../types'

interface ExportMenuProps {
  doc: KnowledgeBaseDoc
  /** 作为「更多」下拉菜单项渲染（整行菜单项样式而非工具栏按钮） */
  asMenuItem?: boolean
}

type ExportFormat =
  | 'pdf'
  | 'html'
  | 'word'
  | 'epub'
  | 'latex'
  | 'rtf'
  | 'txt'
  | 'opml'
  | 'markdown'

// REQ-008 / REQ-112 / REQ-111 / REQ-119 单文档导出菜单。
export function ExportMenu({ doc, asMenuItem }: ExportMenuProps) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [includeAnnotations, setIncludeAnnotations] = useState(true)
  const [themes, setThemes] = useState<ThemeSummary[]>([])
  const [themeName, setThemeName] = useState<string>('')
  const [pandocAvailable, setPandocAvailable] = useState(false)
  const [usePandoc, setUsePandoc] = useState(false)

  // 打开时加载主题列表与 Pandoc 检测结果（REQ-111 / REQ-119）
  useEffect(() => {
    if (!open) return
    window.electronAPI.listThemes().then((t) => setThemes(t))
    window.electronAPI.detectPandoc().then((r) => setPandocAvailable(r.available))
  }, [open])

  const handleExport = async (format: ExportFormat) => {
    setBusy(format)
    setOpen(false)
    try {
      const result = await window.electronAPI.exportDoc(
        { kind: 'kbDoc', kbId: doc.kbId, docId: doc.id },
        format,
        {
          includeAnnotations,
          themeName: themeName || undefined,
          usePandoc: usePandoc && pandocAvailable
        }
      )
      if (!result.success) {
        toast.danger(result.error ? `导出失败：${result.error}` : '导出已取消或失败')
      }
    } finally {
      setBusy(null)
    }
  }

  const items: { format: ExportFormat; label: string; icon: typeof FileText; sep?: boolean }[] = [
    { format: 'pdf', label: '导出 PDF', icon: FileText },
    { format: 'html', label: '导出 HTML', icon: FileCode },
    { format: 'word', label: '导出 Word（兼容）', icon: FileType2 },
    { format: 'markdown', label: '导出 Markdown', icon: FileJson, sep: true },
    { format: 'txt', label: '导出纯文本', icon: FileText },
    { format: 'rtf', label: '导出 RTF', icon: FileType },
    { format: 'latex', label: '导出 LaTeX', icon: FileCode },
    { format: 'epub', label: '导出 EPUB', icon: BookOpen },
    { format: 'opml', label: '导出 OPML 大纲', icon: FileJson }
  ]

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy !== null}
        className={
          asMenuItem
            ? 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface-2)]'
            : 'btn-ghost'
        }
        title="导出文档"
      >
        <Download className="h-4 w-4" />
        <span className={asMenuItem ? 'flex-1' : 'hidden xl:inline'}>{busy ? '导出中…' : '导出'}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 min-w-[220px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-md">
            <label className="flex cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-sm text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]">
              <input
                type="checkbox"
                checked={includeAnnotations}
                onChange={(e) => setIncludeAnnotations(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              包含批注
            </label>
            {/* REQ-111 导出专用主题选择 */}
            <label className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-[var(--color-muted-foreground)]">
              <span>导出主题</span>
              <select
                value={themeName}
                onChange={(e) => setThemeName(e.target.value)}
                className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-xs"
              >
                <option value="">应用当前</option>
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            {/* REQ-119 使用 Pandoc 导出（仅在检测到 Pandoc 时可用） */}
            <label
              className={`flex items-center gap-2 rounded px-2.5 py-1.5 text-sm ${
                pandocAvailable
                  ? 'cursor-pointer text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                  : 'text-[var(--color-muted-foreground)] opacity-40'
              }`}
              title={pandocAvailable ? '使用系统 Pandoc 进行更高质量导出' : '未检测到 Pandoc'}
            >
              <input
                type="checkbox"
                checked={usePandoc && pandocAvailable}
                disabled={!pandocAvailable}
                onChange={(e) => setUsePandoc(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              使用 Pandoc {pandocAvailable ? '' : '（未检测到）'}
            </label>
            <div className="divider my-1" />
            {items.map((it) => {
              const Icon = it.icon
              return (
                <div key={it.format}>
                  {it.sep && <div className="divider my-1" />}
                  <button
                    onClick={() => handleExport(it.format)}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-sm text-[var(--color-muted-foreground)] transition-colors hover:bg-[var(--nw-ghost-hover)] hover:text-[var(--color-foreground)]"
                  >
                    <Icon className="h-4 w-4" />
                    {it.label}
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
