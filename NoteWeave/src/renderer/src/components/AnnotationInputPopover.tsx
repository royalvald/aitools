import { useEffect, useRef, useState } from 'react'

interface AnnotationInputPopoverProps {
  /** 被批注的原文片段（截断展示） */
  selectedText: string
  /** 编辑模式下的初始内容；为空字符串表示新增模式 */
  initialContent?: string
  title?: string
  onSubmit: (content: string) => void
  onClose: () => void
}

/**
 * 批注内容输入弹窗。新增与编辑共用。
 * 输入框为空（去空格后）时禁用「确定」，不创建空批注。
 */
export function AnnotationInputPopover({
  selectedText,
  initialContent = '',
  title = '添加批注',
  onSubmit,
  onClose
}: AnnotationInputPopoverProps) {
  const [content, setContent] = useState(initialContent)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const trimmed = content.trim()
  const canSubmit = trimmed.length > 0

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit(content.trim())
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const preview = selectedText.length > 60 ? `${selectedText.slice(0, 60)}…` : selectedText

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-foreground)]/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="flex w-full flex-col rounded-lg bg-[var(--color-surface)] shadow-lg"
        style={{ maxWidth: 'min(32rem, calc(100vw - 2rem))' }}
        onKeyDown={handleKeyDown}
      >
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <h3 className="font-semibold text-[var(--color-foreground)]">{title}</h3>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">选中原文</div>
            <div className="max-h-24 overflow-y-auto rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
              {preview}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">批注内容</div>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="写下你的批注…"
              rows={4}
              className="input resize-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="btn-secondary"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-primary"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
