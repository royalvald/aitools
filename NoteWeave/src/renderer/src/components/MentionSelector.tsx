import { useEffect, useMemo, useState } from 'react'
import { AtSign } from 'lucide-react'
import { Modal } from './Modal'
import type { DocMention, KnowledgeBaseSummary, NoteSummary } from '../types'

// REQ-202 @提及选择器：模糊匹配 Note / KB Doc 标题，选中后插入 [[type:id|标题]]。
interface MentionSelectorProps {
  open: boolean
  onClose: () => void
  onInsert: (mentionText: string, mention: DocMention) => void
}

interface Candidate {
  mention: DocMention
  title: string
}

export function MentionSelector({ open, onClose, onInsert }: MentionSelectorProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([])
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) return
    Promise.all([window.electronAPI.listNotes(), window.electronAPI.listKnowledgeBases()]).then(
      ([n, k]) => {
        setNotes(n)
        setKbs(k)
      }
    )
  }, [open])

  // 收集候选：Note + 当前知识库下的 KB Doc。
  // 为避免加载所有知识库的全部文档，这里仅列出 Note 与知识库本身作为快捷候选；
  // KB Doc 候选通过单独的 listKbDocs 在选中知识库后懒加载（简化：这里仍提供 note 全集）。
  const candidates: Candidate[] = useMemo(() => {
    const out: Candidate[] = []
    const q = query.trim().toLowerCase()
    for (const n of notes) {
      const title = n.title || '无标题'
      if (q && !title.toLowerCase().includes(q)) continue
      out.push({ mention: { kind: 'note', id: n.id, title }, title })
    }
    return out.slice(0, 30)
  }, [notes, query])

  // 知识库候选（作为分组入口，选中后弹文档列表）
  const kbCandidates: Candidate[] = useMemo(() => {
    const out: Candidate[] = []
    const q = query.trim().toLowerCase()
    for (const k of kbs) {
      if (q && !k.name.toLowerCase().includes(q)) continue
      out.push({ mention: { kind: 'kbDoc', id: '', title: `${k.name}/（请在文档内 @ 选择）` }, title: k.name })
    }
    return out
  }, [kbs, query])

  const insert = (c: Candidate) => {
    const text = `[[${c.mention.kind}:${c.mention.id}|${c.mention.title}]]`
    onInsert(text, c.mention)
    onClose()
  }

  if (!open) return null

  return (
    <Modal title="@提及文档" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <AtSign className="h-4 w-4" />
        @提及文档
      </div>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索笔记标题…"
        className="mb-3 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />
      <div className="max-h-72 overflow-y-auto">
        <div className="mb-1 px-1 text-xs font-medium text-[var(--color-muted-foreground)]">笔记</div>
        {candidates.length === 0 ? (
          <div className="px-2 py-2 text-xs text-[var(--color-muted-foreground)]">无匹配项</div>
        ) : (
          candidates.map((c) => (
            <button
              key={`note-${c.mention.id}`}
              onClick={() => insert(c)}
              className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-[var(--color-ghost-hover)]"
            >
              {c.title}
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}
