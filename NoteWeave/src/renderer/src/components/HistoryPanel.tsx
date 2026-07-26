import { useEffect, useState } from 'react'
import { GitCompare, History, RotateCcw, X } from 'lucide-react'
import { Modal } from './Modal'
import { useConfirm } from './ConfirmDialog'
import { formatFullDate } from '../lib/utils'
import { diffLines } from '../lib/diff'
import { cn } from '../lib/utils'
import type { HistoryItem, HistorySummary } from '../types'

interface HistoryPanelProps {
  scope: 'note' | 'kbDoc'
  refId: string
  currentContent: string
  onClose: () => void
  /** 恢复到指定内容后回调（父组件用该内容覆盖并保存）。 */
  onRestore: (content: string) => Promise<void> | void
}

// REQ-014 版本历史面板：列出历史快照，可预览、对比与恢复到指定版本。
export function HistoryPanel({ scope, refId, currentContent, onClose, onRestore }: HistoryPanelProps) {
  const confirm = useConfirm()
  const [items, setItems] = useState<HistorySummary[]>([])
  const [selected, setSelected] = useState<HistoryItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState(false)
  // REQ-014：对比模式（历史版本 vs 当前内容，或两个历史版本互比）
  const [diffMode, setDiffMode] = useState(false)
  // REQ-014：对比基准版本（用于双版本对比；为 null 时与当前内容对比）
  const [base, setBase] = useState<HistoryItem | null>(null)

  useEffect(() => {
    window.electronAPI.listHistory(scope, refId).then((list) => {
      setItems(list)
      setLoading(false)
    })
  }, [scope, refId])

  const viewItem = async (id: string) => {
    const item = await window.electronAPI.getHistory(id)
    setSelected(item)
  }

  const toggleBase = async (id: string) => {
    // 再次点击同一基准则取消
    if (base?.id === id) {
      setBase(null)
      return
    }
    const item = await window.electronAPI.getHistory(id)
    setBase(item)
  }

  const handleRestore = async () => {
    if (!selected) return
    const ok = await confirm({
      title: '恢复历史版本',
      description: '恢复后将用该历史版本覆盖当前内容（当前未保存内容会先自动保存一个新快照）。确定吗？',
      confirmText: '恢复'
    })
    if (!ok) {
      return
    }
    setRestoring(true)
    try {
      await onRestore(selected.content)
      onClose()
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Modal title="版本历史" onClose={onClose}>
      <div className="flex gap-3" style={{ minHeight: '40vh' }}>
        {/* 版本列表 */}
        <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-[var(--color-border)] pr-2">
          {loading ? (
            <div className="py-6 text-center text-xs text-[var(--color-muted-foreground)]">加载中…</div>
          ) : items.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-xs text-[var(--color-muted-foreground)]">
              <History className="h-6 w-6 opacity-40" />
              暂无历史版本
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {items.map((item) => {
                const isSelected = selected?.id === item.id
                const isBase = base?.id === item.id
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => viewItem(item.id)}
                      className={`w-full rounded-md px-2.5 py-2 text-left text-xs transition-colors ${
                        isSelected
                          ? 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                          : 'text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                      }`}
                    >
                      <div className="font-medium">{formatFullDate(item.savedAt)}</div>
                      <div className="mt-0.5 text-[10px] opacity-70">{item.length} 字符</div>
                    </button>
                    <button
                      onClick={() => toggleBase(item.id)}
                      className={`mt-0.5 flex w-full items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors ${
                        isBase
                          ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                          : 'text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                      }`}
                      title={isBase ? '取消对比基准' : '设为对比基准'}
                    >
                      <GitCompare className="h-3 w-3" />
                      {isBase ? '对比基准' : '设为对比基准'}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* 内容预览 */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <div className="flex h-full flex-col">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  {base && base.id !== selected.id
                    ? `对比：${formatFullDate(base.savedAt)} → ${formatFullDate(selected.savedAt)}`
                    : formatFullDate(selected.savedAt)}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setDiffMode((v) => !v)}
                    className={cn(
                      'btn-ghost text-xs',
                      diffMode && 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                    )}
                    title={base && base.id !== selected.id ? '与基准版本对比' : '与当前内容对比'}
                  >
                    <GitCompare className="h-3.5 w-3.5" />
                    {diffMode
                      ? '退出对比'
                      : base && base.id !== selected.id
                        ? '与基准对比'
                        : '与当前对比'}
                  </button>
                  <button
                    onClick={handleRestore}
                    disabled={restoring || selected.content === currentContent}
                    className="btn-primary text-xs disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {restoring ? '恢复中…' : '恢复此版本'}
                  </button>
                </div>
              </div>
              {diffMode ? (
                <div className="min-h-0 max-h-[45vh] flex-1 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-xs">
                  {(() => {
                    // 选了基准且基准≠当前预览版本：对比「基准 → 选中版本」；
                    // 否则回退为「历史版本 → 当前内容」。add=右侧新增，del=右侧已删除。
                    const twoVersion = base && base.id !== selected.id
                    const oldText = twoVersion ? base!.content : selected.content
                    const newText = twoVersion ? selected.content : currentContent
                    const diff = diffLines(oldText, newText)
                    if (diff.every((d) => d.op === 'equal')) {
                      return (
                        <div className="py-4 text-center text-[var(--color-muted-foreground)]">
                          {twoVersion ? '两个版本完全一致' : '与当前内容完全一致'}
                        </div>
                      )
                    }
                    return diff.map((line, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          'whitespace-pre-wrap px-1',
                          line.op === 'add' && 'bg-[var(--color-success-soft)]/60 text-[var(--color-success)] dark:bg-[var(--color-success)]/30 dark:text-[var(--color-success)]',
                          line.op === 'del' && 'bg-[var(--color-danger-soft)]/60 text-[var(--color-danger)] line-through dark:bg-[var(--color-danger)]/30 dark:text-[var(--color-danger)]'
                        )}
                      >
                        <span className="mr-1 select-none opacity-50">
                          {line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '}
                        </span>
                        {line.text || ' '}
                      </div>
                    ))
                  })()}
                </div>
              ) : (
                <pre className="markdown-body min-h-0 max-h-[45vh] flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs">
                  {selected.content || '（空文档）'}
                </pre>
              )}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
              <X className="mr-1 h-4 w-4 opacity-0" />
              选择左侧版本以预览
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
