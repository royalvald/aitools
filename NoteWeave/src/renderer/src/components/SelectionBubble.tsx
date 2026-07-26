import { useEffect, useRef, useState } from 'react'
import { Bold, Code, Highlighter, Italic, Link2, Strikethrough } from 'lucide-react'
import { cn } from '../lib/utils'

// WYSIWYG 选区气泡菜单（Typora/Notion 式）：选中文字后浮现于选区上方，
// 提供 加粗 / 斜体 / 删除线 / 高亮 / 行内代码 / 链接。
// 链接用内联 popover 输入（替代 window.prompt）。

export interface BubblePosition {
  /** 相对编辑器容器（position:relative）的坐标，选区第一行顶部中点。 */
  top: number
  left: number
}

export type BubbleAction = 'bold' | 'italic' | 'strike' | 'highlight' | 'code'

interface SelectionBubbleProps {
  position: BubblePosition
  /** 判断某格式是否已作用于当前选区（用于按钮高亮）。 */
  isActive: (action: BubbleAction) => boolean
  onToggle: (action: BubbleAction) => void
  /** 当前选区上的链接地址（无则返回空串）。 */
  getCurrentLink: () => string
  /** 应用链接；href 为空串表示移除链接。 */
  onApplyLink: (href: string) => void
  /** Ctrl+K 唤起链接输入框的信号（值变化时打开链接输入）。 */
  linkSignal?: number
}

const ITEMS: { action: BubbleAction; icon: typeof Bold; label: string; shortcut?: string }[] = [
  { action: 'bold', icon: Bold, label: '加粗', shortcut: 'Ctrl+B' },
  { action: 'italic', icon: Italic, label: '斜体', shortcut: 'Ctrl+I' },
  { action: 'strike', icon: Strikethrough, label: '删除线' },
  { action: 'highlight', icon: Highlighter, label: '高亮' },
  { action: 'code', icon: Code, label: '行内代码' }
]

export function SelectionBubble({ position, isActive, onToggle, getCurrentLink, onApplyLink, linkSignal }: SelectionBubbleProps) {
  const [linkMode, setLinkMode] = useState(false)
  const [href, setHref] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const openLinkInput = () => {
    setHref(getCurrentLink())
    setLinkMode(true)
  }

  useEffect(() => {
    if (linkMode) inputRef.current?.focus()
  }, [linkMode])

  // Ctrl+K 等外部信号唤起链接输入框
  useEffect(() => {
    if (linkSignal) openLinkInput()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkSignal])

  const apply = () => {
    onApplyLink(href.trim())
    setLinkMode(false)
  }

  const btn = (active: boolean) =>
    cn(
      'flex h-7 w-7 items-center justify-center rounded transition-colors',
      active
        ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
        : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground)]'
    )

  return (
    <div
      className="absolute z-20 flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1 py-1 shadow-lg"
      style={{ top: position.top - 10, left: position.left, transform: 'translate(-50%, -100%)' }}
      // 阻止 mousedown 夺走编辑器焦点/选区
      onMouseDown={(e) => e.preventDefault()}
    >
      {linkMode ? (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            className="input h-7 w-52 px-2 text-xs"
            placeholder="输入链接地址，留空移除链接"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                apply()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setLinkMode(false)
              }
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            className={btn(false)}
            title="确认"
            onClick={apply}
          >
            <span className="text-xs font-medium">确定</span>
          </button>
        </div>
      ) : (
        <>
          {ITEMS.map(({ action, icon: Icon, label, shortcut }) => (
            <button
              key={action}
              type="button"
              className={btn(isActive(action))}
              title={shortcut ? `${label}（${shortcut}）` : label}
              onClick={() => onToggle(action)}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          <div className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />
          <button
            type="button"
            className={btn(!!getCurrentLink())}
            title="链接"
            onClick={openLinkInput}
          >
            <Link2 className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  )
}
