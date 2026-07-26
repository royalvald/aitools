import { useState } from 'react'
import { Loader2, Languages } from 'lucide-react'
import { Modal } from './Modal'
import { useAi } from '../hooks/useAi'
import { buildPrompt } from '../../../shared/ai-prompts'

// REQ-218 文档翻译：选择目标语言，调用 AI 翻译全文，结果保存为新文档（双向链接）。
interface TranslateDialogProps {
  open: boolean
  onClose: () => void
  /** 原文标题 */
  title: string
  /** 原文 Markdown 内容 */
  content: string
  /** 翻译完成回调：传入译文与目标语言，由父组件创建新文档并建立双向链接 */
  onTranslated: (translated: string, targetLang: string) => Promise<void> | void
}

const COMMON_LANGS = ['英文', '中文', '日文', '韩文', '法文', '德文', '西班牙文']

export function TranslateDialog({ open, onClose, title, content, onTranslated }: TranslateDialogProps) {
  const { generate, enabled, loading } = useAi()
  const [lang, setLang] = useState('英文')
  const [customLang, setCustomLang] = useState('')
  const [status, setStatus] = useState<'idle' | 'translating' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')

  if (!open) return null

  const targetLang = customLang.trim() || lang

  const handleTranslate = async () => {
    setStatus('translating')
    setError('')
    // 标题 + 正文一起翻译
    const fullText = `# ${title}\n\n${content}`
    const r = await generate(buildPrompt({ action: 'translate', text: fullText, targetLang }))
    if (!r.ok || !r.text) {
      setStatus('error')
      setError(r.error ?? '翻译失败')
      return
    }
    try {
      await onTranslated(r.text, targetLang)
      setStatus('done')
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title="文档翻译（AI）" onClose={onClose}>
      <div className="space-y-3 text-sm">
        {!enabled && (
          <div className="rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
            AI 未启用。请先在设置中开启 Ollama 并配置模型，才能进行翻译。
          </div>
        )}
        <div>
          <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">目标语言</div>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_LANGS.map((l) => (
              <button
                key={l}
                onClick={() => {
                  setLang(l)
                  setCustomLang('')
                }}
                className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                  lang === l && !customLang
                    ? 'bg-[var(--color-accent)] text-[var(--color-primary-foreground)]'
                    : 'bg-[var(--color-ghost)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-ghost-hover)]'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
          <input
            value={customLang}
            onChange={(e) => setCustomLang(e.target.value)}
            placeholder="或输入其它语言（如俄文）"
            className="mt-2 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </div>

        <div className="rounded-md bg-[var(--color-ghost)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
          翻译完成后将创建一个新文档（译文），并在原文与译文之间建立双向链接（@提及），可互相跳转。
        </div>

        {status === 'translating' && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在翻译…（长文本可能需要较长时间）
          </div>
        )}
        {status === 'done' && (
          <div className="badge badge-success px-3 py-2 text-xs">
            ✓ 翻译完成，已创建译文文档。
          </div>
        )}
        {status === 'error' && (
          <div className="badge badge-danger px-3 py-2 text-xs">{error}</div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">
            关闭
          </button>
          <button
            onClick={handleTranslate}
            disabled={!enabled || loading || status === 'translating'}
            className="btn-primary disabled:opacity-50"
          >
            <span className="flex items-center gap-1">
              <Languages className="h-4 w-4" />
              {status === 'translating' ? '翻译中…' : `翻译为${targetLang}`}
            </span>
          </button>
        </div>
      </div>
    </Modal>
  )
}
