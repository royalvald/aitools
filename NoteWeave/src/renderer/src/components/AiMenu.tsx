import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { Modal } from './Modal'
import { useAi } from '../hooks/useAi'
import { cn } from '../lib/utils'
import type { AiAction } from '../../../shared/ai-prompts'

// REQ-215 AI 菜单：续写/摘要/翻译/解释/问答。
// 对选中文本（无则全文）执行；结果可插入到光标处或复制。
interface AiMenuProps {
  /** 选中文本；为空时使用全文 */
  selectionText: string
  fullText: string
  /** 把结果插入到编辑器（如无则无效） */
  onInsert?: (text: string) => void
  /** 作为「更多」下拉菜单项渲染（整行菜单项样式而非工具栏按钮） */
  asMenuItem?: boolean
}

const ACTIONS: { value: AiAction; label: string; desc: string }[] = [
  { value: 'continue', label: '续写', desc: '基于选中/全文继续写作' },
  { value: 'summarize', label: '摘要', desc: '生成要点总结' },
  { value: 'translate', label: '翻译', desc: '翻译为目标语言' },
  { value: 'explain', label: '解释', desc: '通俗解释内容' },
  { value: 'qa', label: '问答', desc: '基于内容回答问题' }
]

export function AiMenu({ selectionText, fullText, onInsert, asMenuItem }: AiMenuProps) {
  const { runAction, loading, enabled } = useAi()
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<string>('')
  const [error, setError] = useState('')
  const [resultOpen, setResultOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [translateLang, setTranslateLang] = useState('英文')
  const [qaQuestion, setQaQuestion] = useState('')
  const [pendingAction, setPendingAction] = useState<AiAction | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!enabled) return null

  const text = selectionText.trim() || fullText.trim()
  if (!text) return null

  const startAction = async (action: AiAction) => {
    setOpen(false)
    setError('')
    setResult('')
    setPendingAction(action)
    if (action === 'translate' || action === 'qa') {
      setResultOpen(true) // 需要额外输入参数，先打开结果窗等待
      return
    }
    setResultOpen(true)
    const r = await runAction({ action, text })
    if (r.ok) setResult(r.text ?? '')
    else setError(r.error ?? '调用失败')
  }

  const confirmParamAction = async () => {
    if (!pendingAction) return
    setError('')
    const r = await runAction({
      action: pendingAction,
      text,
      targetLang: translateLang,
      question: qaQuestion
    })
    if (r.ok) setResult(r.text ?? '')
    else setError(r.error ?? '调用失败')
  }

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={
            asMenuItem
              ? 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface-2)]'
              : 'btn-ghost'
          }
          title="AI 助手（Ollama）"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          <span className={asMenuItem ? 'flex-1' : undefined}>AI 助手</span>
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <div className="absolute right-0 top-full z-40 mt-1.5 w-56 surface-elevated py-1 text-sm">
            <div className="px-3 py-1 text-[11px] text-[var(--color-muted-foreground)]">
              {selectionText.trim() ? '对选中文本' : '对全文'} · {text.length} 字
            </div>
            {ACTIONS.map((a) => (
              <button
                key={a.value}
                onClick={() => startAction(a.value)}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)]"
              >
                <Wand2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                <div>
                  <div className="text-[var(--color-foreground)]">{a.label}</div>
                  <div className="text-[11px] text-[var(--color-muted-foreground)]">{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {resultOpen && (
        <Modal title={`AI 结果${pendingAction ? '·' + (ACTIONS.find((a) => a.value === pendingAction)?.label ?? '') : ''}`} onClose={() => setResultOpen(false)}>
          <div className="space-y-3 text-sm">
            {pendingAction === 'translate' && !result && (
              <label className="flex items-center gap-2">
                <span className="w-20 text-[var(--color-muted-foreground)]">目标语言</span>
                <input
                  value={translateLang}
                  onChange={(e) => setTranslateLang(e.target.value)}
                  placeholder="英文 / 中文 / 日文…"
                  className="input flex-1"
                />
                <button onClick={confirmParamAction} className="btn-primary">翻译</button>
              </label>
            )}
            {pendingAction === 'qa' && !result && (
              <div className="flex flex-col gap-2">
                <input
                  value={qaQuestion}
                  onChange={(e) => setQaQuestion(e.target.value)}
                  placeholder="你的问题…"
                  className="w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 outline-none"
                />
                <button onClick={confirmParamAction} className="btn-primary self-end">提问</button>
              </div>
            )}
            {loading && (
              <div className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
                <Loader2 className="h-4 w-4 animate-spin" /> 生成中…
              </div>
            )}
            {error && <div className="badge badge-danger px-3 py-2 text-xs">{error}</div>}
            {result && (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-ghost)] p-3 max-h-80 overflow-y-auto whitespace-pre-wrap">
                {result}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(result).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
                disabled={!result}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-50"
              >
                <span className="flex items-center gap-1">
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '已复制' : '复制'}
                </span>
              </button>
              {onInsert && (
                <button
                  onClick={() => {
                    onInsert(result)
                    setResultOpen(false)
                  }}
                  disabled={!result}
                  className="btn-primary disabled:opacity-50"
                >
                  插入到文档
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
