import { useEffect, useRef, useState } from 'react'
import { Clock } from 'lucide-react'

interface TimestampButtonProps {
  /** ISO 时间字符串 */
  value: string
  /** 已格式化好的显示文本 */
  formatted: string
}

/**
 * 时钟图标按钮 + 点击弹出气泡。默认完全不显示时间，
 * 点击后在按钮下方浮出气泡展示更新时间，点击外部任意处自动关闭。
 */
export function TimestampButton({ value, formatted }: TimestampButtonProps) {
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

  // 无值时按钮禁用，避免展示空气泡
  const disabled = !value

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        title="查看更新时间"
        className="btn-icon disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Clock className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 whitespace-nowrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-muted-foreground)] shadow-[var(--shadow-md)]">
          更新于 {formatted}
        </div>
      )}
    </div>
  )
}
