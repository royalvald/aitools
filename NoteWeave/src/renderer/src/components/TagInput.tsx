import { useRef, useState } from 'react'
import { Tag, X } from 'lucide-react'
import { cn } from '../lib/utils'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  /** 已有标签候选项（自动补全），可选 */
  suggestions?: string[]
  placeholder?: string
  /** 内部输入框 id，用于外部 <label htmlFor> 关联 */
  inputId?: string
}

// REQ-012 标签输入：回车/逗号添加标签；点击 × 删除；支持候选项自动补全。
export function TagInput({ tags, onChange, suggestions = [], placeholder = '添加标签…', inputId }: TagInputProps) {
  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = (raw: string) => {
    const v = raw.trim().replace(/^[#,]/, '').trim()
    if (!v) return
    if (tags.some((t) => t.toLowerCase() === v.toLowerCase())) {
      setInput('')
      return
    }
    onChange([...tags, v])
    setInput('')
  }

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag))
  }

  const filteredSuggestions = suggestions
    .filter((s) => !tags.includes(s))
    .filter((s) => (input ? s.toLowerCase().includes(input.toLowerCase()) : true))
    .slice(0, 6)

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      <Tag className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" />
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-[var(--nw-accent-soft)] px-2 py-0.5 text-xs text-[var(--color-primary)]"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="rounded-full hover:text-[var(--color-accent)]"
            title="移除标签"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={inputId}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          // 失焦时若有未确认输入则提交
          if (input.trim()) addTag(input)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            addTag(input)
          } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
            removeTag(tags[tags.length - 1])
          }
        }}
        placeholder={placeholder}
        className="min-w-[80px] flex-1 bg-transparent text-xs text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-muted-foreground)]"
      />
      {focused && input && filteredSuggestions.length > 0 && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-md">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                addTag(s)
              }}
              className={cn(
                'block w-full rounded px-2 py-1 text-left text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)] hover:text-[var(--color-foreground)]'
              )}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
