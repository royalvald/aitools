import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useSettings } from '../hooks/useSettings'
import { cn } from '../lib/utils'
import type { AppSettings } from '../types'

type Theme = AppSettings['theme']

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '亮色', icon: Sun },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor }
]

interface ThemeToggleProps {
  /** 折叠态：仅显示图标按钮，点击在三者间循环 */
  collapsed?: boolean
}

// REQ-010 主题切换：亮 / 暗 / 跟随系统。改动会经 useSettings 即时落盘并联动 <html>。
export function ThemeToggle({ collapsed = false }: ThemeToggleProps) {
  const { settings, update } = useSettings()
  const [open, setOpen] = useState(false)
  const current = settings.theme
  const ActiveIcon = OPTIONS.find((o) => o.value === current)?.icon ?? Sun

  if (collapsed) {
    return (
      <button
        onClick={() => {
          const idx = OPTIONS.findIndex((o) => o.value === current)
          update({ theme: OPTIONS[(idx + 1) % OPTIONS.length].value })
        }}
        className="btn-icon"
        title={`主题：${OPTIONS.find((o) => o.value === current)?.label}（点击切换）`}
      >
        <ActiveIcon className="h-4 w-4" />
      </button>
    )
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost"
        title="切换主题"
      >
        <ActiveIcon className="h-4 w-4" />
        <span className="hidden lg:inline">{OPTIONS.find((o) => o.value === current)?.label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 min-w-[140px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-md">
            {OPTIONS.map((opt) => {
              const Icon = opt.icon
              return (
                <button
                  key={opt.value}
                  onClick={() => {
                    update({ theme: opt.value })
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-sm transition-colors',
                    current === opt.value
                      ? 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                      : 'text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {opt.label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
