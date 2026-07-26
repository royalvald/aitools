import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from './Modal'
import type { KnowledgeBaseDocSummary, KnowledgeBaseSummary, NoteSummary } from '../types'

interface LinkSelectorProps {
  mode: 'note-to-doc' | 'doc-to-note'
  noteId?: string
  kbDocId?: string
  onClose: () => void
  onLinked: () => void
}

export function LinkSelector({ mode, noteId, kbDocId, onClose, onLinked }: LinkSelectorProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([])
  const [docsByKb, setDocsByKb] = useState<Record<string, KnowledgeBaseDocSummary[]>>({})
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)

    async function load() {
      if (mode === 'doc-to-note') {
        const [allNotes, linked] = await Promise.all([
          window.electronAPI.listNotes(),
          kbDocId ? window.electronAPI.listLinksForDoc(kbDocId) : Promise.resolve([])
        ])
        if (cancelled) return
        setNotes(allNotes)
        setLinkedIds(new Set(linked.map((n) => n.id)))
      } else {
        const [allKbs, linked] = await Promise.all([
          window.electronAPI.listKnowledgeBases(),
          noteId ? window.electronAPI.listLinksForNote(noteId) : Promise.resolve([])
        ])
        if (cancelled) return
        setKbs(allKbs)
        setLinkedIds(new Set(linked.map((d) => d.id)))

        const docsMap: Record<string, KnowledgeBaseDocSummary[]> = {}
        for (const kb of allKbs) {
          const docs = await window.electronAPI.listKbDocs(kb.id)
          docsMap[kb.id] = docs
        }
        if (cancelled) return
        setDocsByKb(docsMap)
      }
      if (!cancelled) setIsLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [mode, noteId, kbDocId])

  const handleLink = useCallback(
    async (targetId: string) => {
      if (mode === 'note-to-doc' && noteId) {
        await window.electronAPI.addLink(noteId, targetId)
      } else if (mode === 'doc-to-note' && kbDocId) {
        await window.electronAPI.addLink(targetId, kbDocId)
      }
      onLinked()
      onClose()
    },
    [mode, noteId, kbDocId, onLinked, onClose]
  )

  const filteredNotes = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return notes.filter((n) => !linkedIds.has(n.id))
    return notes
      .filter((n) => !linkedIds.has(n.id))
      .filter((n) => n.title.toLowerCase().includes(term) || n.summary.toLowerCase().includes(term))
  }, [notes, linkedIds, search])

  const filteredDocs = useMemo(() => {
    const term = search.trim().toLowerCase()
    const result: { kb: KnowledgeBaseSummary; docs: KnowledgeBaseDocSummary[] }[] = []
    for (const kb of kbs) {
      const docs = (docsByKb[kb.id] ?? [])
        .filter((d) => !linkedIds.has(d.id))
        .filter((d) => {
          if (!term) return true
          return d.name.toLowerCase().includes(term) || kb.name.toLowerCase().includes(term)
        })
      if (docs.length > 0) {
        result.push({ kb, docs })
      }
    }
    return result
  }, [kbs, docsByKb, linkedIds, search])

  return (
    <Modal
      title={mode === 'note-to-doc' ? '关联知识库文档' : '关联笔记'}
      onClose={onClose}
    >
      <div className="mb-3 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <Search className="h-4 w-4 text-[var(--color-muted-foreground)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={mode === 'note-to-doc' ? '搜索文档或知识库' : '搜索笔记'}
          className="flex-1 text-sm outline-none"
        />
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">加载中…</div>
      ) : mode === 'doc-to-note' ? (
        filteredNotes.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">没有可关联的笔记</div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {filteredNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => handleLink(note.id)}
                className="text-left rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 transition-colors hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-ring)]"
              >
                <div className="font-medium text-[var(--color-foreground)]">{note.title || '无标题'}</div>
                {note.summary && (
                  <p className="line-clamp-2 text-xs text-[var(--color-muted-foreground)]">{note.summary}</p>
                )}
              </button>
            ))}
          </div>
        )
      ) : filteredDocs.length === 0 ? (
        <div className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">没有可关联的文档</div>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
          {filteredDocs.map(({ kb, docs }) => (
            <div key={kb.id}>
              <div className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">{kb.name}</div>
              <div className="flex flex-col gap-2">
                {docs.map((doc) => (
                  <button
                    key={doc.id}
                    onClick={() => handleLink(doc.id)}
                    className="text-left rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 transition-colors hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-ring)]"
                  >
                    <div className="font-medium text-[var(--color-foreground)]">{doc.name}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
