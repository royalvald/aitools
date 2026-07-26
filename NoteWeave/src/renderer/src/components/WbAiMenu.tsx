import { useState } from 'react'
import { ChevronDown, ListChecks, Sparkles, Wand2 } from 'lucide-react'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { useAi } from '../hooks/useAi'
import {
  buildSummarizePrompt,
  buildRecordSummaryPrompt,
  buildDraftPrompt,
  parseDraftOutput,
  type DraftElement
} from '../../../shared/wb-ai-prompts'
import type { WhiteboardElement } from '../types'

// REQ-230 白板 AI 辅助：总结选中便签、生成记录摘要+行动项、按提示生成初稿。
interface WbAiMenuProps {
  /** 当前全部便签元素（用于总结/摘要；选中由调用方过滤后传入） */
  stickyTexts: string[]
  /** 应用生成的初稿元素（覆盖当前白板，需确认） */
  onApplyDraft: (elements: DraftElement[]) => void
}

const COLORS = ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3']

export function WbAiMenu({ stickyTexts, onApplyDraft }: WbAiMenuProps) {
  const { generate, enabled, loading } = useAi()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [mode, setMode] = useState<'summary' | 'record' | 'draft'>('summary')

  if (!enabled) return null

  const runSummary = async () => {
    setOpen(false)
    setMode('summary')
    setResult('')
    setError('')
    setResultOpen(true)
    if (stickyTexts.length === 0) {
      setError('没有可总结的便签')
      return
    }
    const r = await generate(buildSummarizePrompt(stickyTexts))
    if (r.ok) setResult(r.text ?? '')
    else setError(r.error ?? '调用失败')
  }
  const runRecord = async () => {
    setOpen(false)
    setMode('record')
    setResult('')
    setError('')
    setResultOpen(true)
    if (stickyTexts.length === 0) {
      setError('没有便签可生成记录')
      return
    }
    const r = await generate(buildRecordSummaryPrompt(stickyTexts))
    if (r.ok) setResult(r.text ?? '')
    else setError(r.error ?? '调用失败')
  }
  const runDraft = async () => {
    setOpen(false)
    setMode('draft')
    setResult('')
    setError('')
    setResultOpen(true)
    const r = await generate(buildDraftPrompt(draftPrompt.trim() || '项目启动计划'))
    if (r.ok && r.text) {
      const els = parseDraftOutput(r.text)
      if (els.length === 0) {
        setError('AI 未返回有效元素，请重试或调整描述')
      } else {
        setResult(`已生成 ${els.length} 个元素，点击「应用为白板初稿」覆盖当前画布。`)
        // 暂存到 result 末尾不便于解析；直接 apply 用闭包
        ;(window as unknown as { __wbDraft?: DraftElement[] }).__wbDraft = els
      }
    } else setError(r.error ?? '调用失败')
  }

  return (
    <>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="btn-ghost"
          title="白板 AI 辅助"
        >
          <Sparkles className="h-4 w-4" />
          AI
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-1 w-56 surface-elevated py-1 text-sm">
              <div className="px-3 py-1 text-[11px] text-[var(--color-muted-foreground)]">
                {stickyTexts.length > 0 ? `基于 ${stickyTexts.length} 个便签` : '无便签内容'}
              </div>
              <button onClick={runSummary} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)]">
                <Wand2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                <div>
                  <div className="text-[var(--color-foreground)]">主题聚类/总结</div>
                  <div className="text-[11px] text-[var(--color-muted-foreground)]">归类要点 + 行动建议</div>
                </div>
              </button>
              <button onClick={runRecord} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)]">
                <ListChecks className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                <div>
                  <div className="text-[var(--color-foreground)]">记录摘要 + 行动项</div>
                  <div className="text-[11px] text-[var(--color-muted-foreground)]">生成 Markdown 记录</div>
                </div>
              </button>
              <button onClick={() => { setMode('draft'); setOpen(false); setResultOpen(true); setResult(''); setError('') }} className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-surface-2)]">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                <div>
                  <div className="text-[var(--color-foreground)]">生成白板初稿</div>
                  <div className="text-[11px] text-[var(--color-muted-foreground)]">按描述生成便签布局</div>
                </div>
              </button>
            </div>
          </>
        )}
      </div>

      {resultOpen && (
        <Modal title={`白板 AI · ${mode === 'summary' ? '总结' : mode === 'record' ? '记录摘要' : '生成初稿'}`} onClose={() => setResultOpen(false)}>
          <div className="space-y-3 text-sm">
            {mode === 'draft' && (
              <div className="space-y-2">
                <input
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  placeholder="描述要生成的白板（如：项目启动计划）"
                  className="w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 outline-none focus:border-[var(--color-accent)]"
                />
                <button onClick={runDraft} disabled={loading} className="btn-primary disabled:opacity-50">
                  {loading ? '生成中…' : '生成初稿'}
                </button>
              </div>
            )}
            {loading && <div className="text-xs text-[var(--color-muted-foreground)]">AI 生成中…</div>}
            {error && <div className="badge badge-danger px-3 py-2 text-xs">{error}</div>}
            {result && (
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-ghost)] p-3">
                {result}
              </div>
            )}
            <div className="flex justify-end gap-2">
              {(mode === 'summary' || mode === 'record') && result && (
                <button
                  onClick={() => navigator.clipboard.writeText(result)}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5"
                >
                  复制
                </button>
              )}
              {mode === 'draft' && (window as unknown as { __wbDraft?: DraftElement[] }).__wbDraft?.length && (
                <button
                  onClick={async () => {
                    const els = (window as unknown as { __wbDraft?: DraftElement[] }).__wbDraft ?? []
                    const ok = await confirm({
                      title: '应用白板初稿',
                      description: `应用 ${els.length} 个元素到画布？将覆盖当前内容。`,
                      confirmText: '应用',
                      danger: true
                    })
                    if (ok) {
                      onApplyDraft(els)
                      setResultOpen(false)
                    }
                  }}
                  className="btn-primary"
                >
                  应用为白板初稿
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// 工具：把 DraftElement[] 转为白板元素布局（网格排布）
export function layoutDraftElements(drafts: DraftElement[]): WhiteboardElement[] {
  const now = new Date().toISOString()
  const colW = 200
  const rowH = 120
  const perRow = 3
  return drafts.map((d, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    const id = `wb_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`
    if (d.type === 'text') {
      return {
        id,
        type: 'text',
        x: 80 + col * colW,
        y: 40 + row * rowH,
        width: 180,
        height: 40,
        text: d.text,
        fontSize: 18,
        color: '#1e293b',
        zIndex: i + 1,
        createdAt: now,
        updatedAt: now
      } as WhiteboardElement
    }
    return {
      id,
      type: 'sticky',
      x: 80 + col * colW,
      y: 80 + row * rowH,
      width: 180,
      height: 100,
      text: d.text,
      color: d.color || COLORS[i % COLORS.length],
      zIndex: i + 1,
      createdAt: now,
      updatedAt: now
    } as WhiteboardElement
  })
}
