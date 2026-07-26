import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import type { LintIssue } from '../types'

// REQ-118 Markdown Lint 面板：列出当前文档问题，点击跳转（源码模式下滚动到对应行）。

interface LintPanelProps {
  content: string
  enabled: boolean
  /** 源码模式下点击问题跳转到行（1-based）。 */
  onGotoLine?: (line: number) => void
}

export function LintPanel({ content, enabled, onGotoLine }: LintPanelProps) {
  const [issues, setIssues] = useState<LintIssue[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setIssues([])
      return
    }
    setLoading(true)
    const t = setTimeout(() => {
      window.electronAPI
        .lintMarkdown(content)
        .then((r) => setIssues(r))
        .catch(() => setIssues([]))
        .finally(() => setLoading(false))
    }, 400)
    return () => clearTimeout(t)
  }, [content, enabled])

  if (!enabled) return null

  return (
    <div className="flex w-60 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 text-sm font-medium">
        <AlertCircle size={14} /> Markdown 检查
        <span className="ml-auto rounded-full bg-[var(--color-accent-soft)] px-2 text-xs text-[var(--color-accent)]">
          {issues.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">检查中…</div>
        )}
        {!loading && issues.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">未发现问题</div>
        )}
        {issues.map((issue, i) => (
          <button
            key={i}
            className="block w-full border-b border-[var(--color-border)] px-3 py-2 text-left text-xs hover:bg-[var(--color-ghost-hover)]"
            onClick={() => onGotoLine?.(issue.line)}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[var(--color-accent)]">L{issue.line}</span>
              <span className="text-[var(--color-muted-foreground)]">{issue.rule}</span>
            </div>
            <div className="mt-0.5 text-[var(--color-foreground)]">{issue.message}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
