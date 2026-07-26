import { Code2, Pencil } from 'lucide-react'
import { cn } from '../lib/utils'
import type { EditorMode } from '../types'

interface EditorModeSwitcherProps {
  mode: EditorMode
  onChange: (mode: EditorMode) => void
  className?: string
  /** REQ-207 只读锁定：锁定时不渲染切换器（仅阅读态可用）。 */
  disableEdit?: boolean
}

/**
 * 编辑器模式切换器（语雀式两档）：
 * - wysiwyg：富文本（所见即所得，Milkdown）——普通文本编辑的默认方式
 * - source：Markdown 源码（需要直接编辑 md 格式时进入）
 *
 * 阅读态由页头「编辑 / 完成」按钮承担，切换器只在编辑态出现，
 * 不再提供「预览 / 即时」档位（EditorMode 类型保留，供设置与派生态使用）。
 */
const MODES: { value: EditorMode; label: string; icon: typeof Pencil; title: string }[] = [
  { value: 'wysiwyg', label: '富文本', icon: Pencil, title: '所见即所得富文本编辑' },
  { value: 'source', label: 'Markdown', icon: Code2, title: 'Markdown 源码编辑' }
]

export function EditorModeSwitcher({ mode, onChange, className, disableEdit }: EditorModeSwitcherProps) {
  if (disableEdit) return null
  // 历史设置可能残留 'instant' 档：归入源码档显示
  const displayMode: EditorMode = mode === 'instant' ? 'source' : mode
  return (
    <div
      className={cn(
        'segmented',
        className
      )}
      role="group"
      aria-label="编辑器模式"
    >
      {MODES.map(({ value, label, icon: Icon, title }) => (
        <button
          key={value}
          type="button"
          aria-pressed={displayMode === value}
          onClick={() => onChange(value)}
          title={title}
          className={cn(
            'segmented-item',
            displayMode === value && 'is-active'
          )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </div>
  )
}
