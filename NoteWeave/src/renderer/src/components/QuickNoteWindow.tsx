import { useEffect, useRef, useState } from 'react'

// REQ-220 极简快速小记浮窗：单一输入框，Enter 保存为 Note，Esc 隐藏。
// 支持多行：Enter 换行，Ctrl/Cmd+Enter 保存。
export function QuickNoteWindow() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const save = async () => {
    const content = text.trim()
    if (!content) {
      window.electronAPI.quickNoteHide()
      return
    }
    setStatus('saving')
    try {
      const r = await window.electronAPI.quickNoteSave(content)
      if (r.ok) {
        setStatus('saved')
        setText('')
        setTimeout(() => {
          window.electronAPI.quickNoteHide()
          setStatus('idle')
        }, 500)
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <div
      className="flex h-dvh w-dvw flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
      style={{ WebkitAppRegion: 'drag' } as never}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-1.5" style={{ WebkitAppRegion: 'no-drag' } as never}>
        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">快速小记</span>
        <span className="text-[10px] text-[var(--color-muted-foreground)]">Ctrl+Enter 保存 · Esc 隐藏</span>
      </div>
      <textarea
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            window.electronAPI.quickNoteHide()
          }
        }}
        placeholder="写下想法，Ctrl+Enter 保存为笔记…"
        className="min-h-0 flex-1 resize-none px-3 py-2 text-sm outline-none"
        style={{ WebkitAppRegion: 'no-drag' } as never}
        spellCheck={false}
      />
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-1.5" style={{ WebkitAppRegion: 'no-drag' } as never}>
        <span className="text-[11px] text-[var(--color-muted-foreground)]">
          {status === 'saving' && '保存中…'}
          {status === 'saved' && '✓ 已保存'}
          {status === 'error' && '保存失败'}
        </span>
        <button
          onClick={() => void save()}
          disabled={!text.trim() || status === 'saving'}
          className="btn-primary text-xs"
        >
          保存
        </button>
      </div>
    </div>
  )
}
