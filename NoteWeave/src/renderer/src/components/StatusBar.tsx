import { useMemo, useState } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { countStats, formatMain, type CountMode } from '../lib/word-count'
import { stripFrontMatter } from '../lib/front-matter'

// REQ-102 底部状态栏：字数/字符/阅读时间 + 选区字数 + 保存状态。

interface StatusBarProps {
  text: string
  /** 选区纯文本（来自编辑器选区）。为空表示无选区。 */
  selection?: string
  /** 保存状态：unsaved 显示未保存圆点，saving 显示旋转器，saved 显示对勾。 */
  saveState?: 'unsaved' | 'saving' | 'saved'
  /** 最近一次自动保存完成时间（ms 时间戳）；saved 态下展示「已保存 HH:MM」。 */
  savedAt?: number | null
}

export function StatusBar({ text, selection, saveState, savedAt }: StatusBarProps) {
  const [mode, setMode] = useState<CountMode>('words')
  // 统计基于正文（去掉 front matter）
  const stats = useMemo(() => countStats(stripFrontMatter(text || '')), [text])
  const selStats = useMemo(
    () => (selection && selection.length > 0 ? countStats(selection) : null),
    [selection]
  )

  return (
    <div className="flex items-center gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-xs text-[var(--color-muted-foreground)]">
      <button
        className="cursor-pointer hover:text-[var(--color-foreground)]"
        title="点击切换显示模式"
        onClick={() =>
          setMode((m) =>
            m === 'words' ? 'chars' : m === 'chars' ? 'readMinutes' : 'words'
          )
        }
      >
        {formatMain(stats, mode)}
      </button>
      <span>字符 {stats.chars}</span>
      <span>段落 {stats.paragraphs}</span>
      {selStats && (
        <span className="text-[var(--color-accent)]">已选 {selStats.words} 字</span>
      )}
      <span className="ml-auto flex items-center gap-3">
        <SaveStateIndicator state={saveState} savedAt={savedAt} />
        <span>阅读约 {stats.readMinutes} 分钟</span>
      </span>
    </div>
  )
}

function SaveStateIndicator({
  state,
  savedAt
}: {
  state?: StatusBarProps['saveState']
  savedAt?: StatusBarProps['savedAt']
}) {
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1 text-[var(--color-primary)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        保存中…
      </span>
    )
  }
  if (state === 'saved') {
    const time = savedAt
      ? new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : null
    return (
      <span
        className="flex items-center gap-1 text-[var(--color-success)]"
        title={savedAt ? `自动保存于 ${new Date(savedAt).toLocaleString('zh-CN')}` : undefined}
      >
        <Check className="h-3 w-3" />
        已保存{time ? ` ${time}` : ''}
      </span>
    )
  }
  if (state === 'unsaved') {
    return (
      <span className="flex items-center gap-1 text-[var(--color-warning)]" title="有未保存的更改">
        <Circle className="h-2 w-2 fill-current" />
        未保存
      </span>
    )
  }
  return null
}
