import { useEffect, useMemo, useState } from 'react'
import { X, ChevronUp, ChevronDown, Replace, CheckCheck, Regex, CaseSensitive } from 'lucide-react'
import { findAll, findNext, findPrev, replaceInRange } from '../lib/find-replace'

// REQ-101 文档内查找替换浮层。
//
// 工作方式：以「当前文档全文（markdown 源码）」为查找目标。每次查找/替换都基于全文区间，
// 通过 props 回调把结果（高亮区间 / 替换后的全文 / 滚动定位）交回父组件。
// 父组件负责：把区间映射到具体编辑器（textarea setSelectionRange 或 Milkdown ProseMirror 选区）。

export interface FindReplaceController {
  /** 在编辑器中选中/高亮指定区间（start/end 为全文偏移），并滚动到可视区。 */
  selectRange: (start: number, end: number) => void
  /** 用替换后的新全文覆盖编辑器内容。 */
  replaceAllContent: (newText: string) => void
  /** 替换单个区间：返回新全文 + 新光标位置（选区起点）。 */
  replaceSingle: (start: number, end: number, replacement: string) => void
  /** 当前全文（用于查找）。 */
  getFullText: () => string
}

interface FindReplaceBarProps {
  open: boolean
  controller: FindReplaceController | null
  onClose: () => void
}

export function FindReplaceBar({ open, controller, onClose }: FindReplaceBarProps) {
  const [mode, setMode] = useState<'find' | 'replace'>('find')
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const text = controller?.getFullText() ?? ''

  // 计算所有匹配区间
  const matches = useMemo(() => {
    if (!open || !query) return []
    try {
      const r = findAll(text, query, { caseSensitive, wholeWord, regex: useRegex })
      setError(null)
      setSuccess(null)
      return r
    } catch (e) {
      setError((e as Error).message)
      return []
    }
  }, [text, query, caseSensitive, wholeWord, useRegex, open])

  // 输入变化时重置激活项
  useEffect(() => {
    setActiveIdx(0)
  }, [query, caseSensitive, wholeWord, useRegex])

  const goto = (idx: number) => {
    if (matches.length === 0) return
    const wrapped = ((idx % matches.length) + matches.length) % matches.length
    setActiveIdx(wrapped)
    const m = matches[wrapped]
    controller?.selectRange(m.start, m.end)
  }

  const handleNext = () => {
    if (matches.length === 0) return
    const current = matches[activeIdx]
    const next = findNext(matches, current ? current.end : 0)
    if (next) {
      const ni = matches.findIndex((m) => m.start === next.start)
      goto(ni)
    }
  }
  const handlePrev = () => {
    if (matches.length === 0) return
    const current = matches[activeIdx]
    const prev = findPrev(matches, current ? current.start : 0)
    if (prev) {
      const pi = matches.findIndex((m) => m.start === prev.start)
      goto(pi)
    }
  }

  const handleReplace = () => {
    if (!controller || matches.length === 0) return
    const m = matches[activeIdx]
    if (!m) return
    const full = controller.getFullText()
    const { text: newText } = replaceInRange(full, [m], replacement)
    // 找下一个未替换匹配位置（替换后偏移变化，重新计算）
    const newCursor = m.start + replacement.length
    controller.replaceSingle(m.start, m.end, replacement)
    void newText
    // 替换后重新定位到下一个匹配
    setTimeout(() => {
      const fresh = controller.getFullText()
      const rs = findAll(fresh, query, { caseSensitive, wholeWord, regex: useRegex })
      const nx = rs.find((r) => r.start >= newCursor) ?? rs[0]
      if (nx) {
        const ni = rs.findIndex((r) => r.start === nx.start)
        setActiveIdx(ni >= 0 ? ni : 0)
        controller.selectRange(nx.start, nx.end)
      }
    }, 0)
  }

  const handleReplaceAll = () => {
    if (!controller || matches.length === 0) return
    const full = controller.getFullText()
    const { text: newText, count } = replaceInRange(full, matches, replacement)
    controller.replaceAllContent(newText)
    setError(null)
    setSuccess(`已替换 ${count} 处`)
  }

  if (!open) return null

  const btn = 'btn-icon'
  const activeBtn = (on: boolean) =>
    on
      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
      : 'text-[var(--color-muted-foreground)]'

  return (
    <div className="find-replace-bar border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 shadow-sm">
      <div className="mx-auto flex max-w-4xl flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              className={`btn-ghost px-2 py-1 text-xs ${mode === 'find' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : ''}`}
              onClick={() => setMode('find')}
              title="查找"
            >
              查找
            </button>
            <button
              className={`btn-ghost px-2 py-1 text-xs ${mode === 'replace' ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : ''}`}
              onClick={() => setMode('replace')}
              title="替换 (Ctrl+H)"
            >
              替换
            </button>
          </div>
          <input
            className="input min-w-0 flex-1 px-2 py-1"
            placeholder="查找内容"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) handlePrev()
                else handleNext()
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
          <button
            className={btn}
            title="区分大小写"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            <span className={`flex items-center justify-center ${activeBtn(caseSensitive)}`}>
              <CaseSensitive size={15} />
            </span>
          </button>
          <button className={btn} title="全字匹配" onClick={() => setWholeWord((v) => !v)}>
            <span className={`flex items-center justify-center font-bold ${activeBtn(wholeWord)}`}>
              W
            </span>
          </button>
          <button className={btn} title="正则表达式" onClick={() => setUseRegex((v) => !v)}>
            <span className={`flex items-center justify-center ${activeBtn(useRegex)}`}>
              <Regex size={15} />
            </span>
          </button>
          <span className="min-w-[60px] text-right text-xs text-[var(--color-muted-foreground)]">
            {matches.length > 0 ? `${activeIdx + 1}/${matches.length}` : '0/0'}
          </span>
          <button className={btn} title="上一个" onClick={handlePrev}>
            <ChevronUp size={15} />
          </button>
          <button className={btn} title="下一个" onClick={handleNext}>
            <ChevronDown size={15} />
          </button>
          <button className={btn} title="关闭 (Esc)" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        {mode === 'replace' && (
          <div className="flex items-center gap-2">
            <input
              className="input min-w-0 flex-1 px-2 py-1"
              placeholder="替换为"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleReplace()
                } else if (e.key === 'Escape') {
                  onClose()
                }
              }}
            />
            <button
              className="btn-ghost flex items-center gap-1 px-2 py-1 text-xs"
              onClick={handleReplace}
              title="替换当前"
            >
              <Replace size={14} /> 替换
            </button>
            <button
              className="btn-ghost flex items-center gap-1 px-2 py-1 text-xs"
              onClick={handleReplaceAll}
              title="全部替换"
            >
              <CheckCheck size={14} /> 全部
            </button>
          </div>
        )}
        {success && (
          <div className="text-xs text-[var(--color-success)]">{success}</div>
        )}
        {error && (
          <div className="text-xs text-[var(--color-danger)]">{error}</div>
        )}
      </div>
    </div>
  )
}
