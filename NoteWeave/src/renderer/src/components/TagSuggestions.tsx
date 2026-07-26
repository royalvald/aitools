import { useEffect, useState } from 'react'
import { Plus, Sparkles, X } from 'lucide-react'
import { useAi } from '../hooks/useAi'
import { useTagSuggestions } from '../hooks/useTagSuggestions'
import { buildTagPrompt, parseTagsOutput } from '../../../shared/ai-prompts'

// REQ-217 自动标签推荐：基于标题+摘要调用本地模型推荐 3 个标签，
// chip 形式显示在 TagInput 下方，点击可添加；可忽略此次推荐。
interface TagSuggestionsProps {
  /** 用于生成推荐的文本（标题 + 摘要/正文片段） */
  text: string
  /** 当前已有标签（避免重复推荐） */
  currentTags: string[]
  /** 添加标签回调 */
  onAddTag: (tag: string) => void
  /** 触发推荐的 key（如 updatedAt / docId）；变化时自动重新推荐（仅在 AI 启用时） */
  triggerKey?: string
}

export function TagSuggestions({ text, currentTags, onAddTag, triggerKey }: TagSuggestionsProps) {
  const { generate, enabled, loading } = useAi()
  const allTags = useTagSuggestions([text])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState('')

  // triggerKey 变化时（保存后 updatedAt 变）自动重新推荐
  useEffect(() => {
    setDismissed(false)
    setSuggestions([])
    setError('')
    if (!enabled || !text.trim() || text.trim().length < 5) return
    let cancelled = false
    void (async () => {
      const r = await generate(buildTagPrompt(text, allTags))
      if (cancelled) return
      if (r.ok && r.text) {
        const tags = parseTagsOutput(r.text).filter(
          (t) => !currentTags.some((c) => c.toLowerCase() === t.toLowerCase())
        )
        setSuggestions(tags)
      } else if (!r.ok) {
        setError(r.error ?? '')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey, enabled])

  if (!enabled || dismissed) return null
  // 过滤掉已添加的
  const visible = suggestions.filter(
    (t) => !currentTags.some((c) => c.toLowerCase() === t.toLowerCase())
  )
  if (visible.length === 0 && !loading && !error) return null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5 text-[10px] text-[var(--color-muted-foreground)]">
        <Sparkles className="h-3 w-3" />
        AI 标签推荐
      </span>
      {loading && <span className="text-[10px] text-[var(--color-muted-foreground)]">生成中…</span>}
      {error && <span className="text-[10px] text-[var(--color-danger)]">{error}</span>}
      {visible.map((tag) => (
        <button
          key={tag}
          onClick={() => onAddTag(tag)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--color-primary)] hover:bg-[var(--color-accent)]/20"
        >
          <Plus className="h-2.5 w-2.5" />
          {tag}
        </button>
      ))}
      <button
        onClick={() => setDismissed(true)}
        className="inline-flex items-center text-[10px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        title="忽略此次推荐"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
