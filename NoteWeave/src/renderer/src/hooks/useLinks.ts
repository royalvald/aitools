import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeBaseDocSummary, NoteSummary } from '../types'

export function useLinks() {
  const [linkedDocs, setLinkedDocs] = useState<KnowledgeBaseDocSummary[]>([])
  const [linkedNotes, setLinkedNotes] = useState<NoteSummary[]>([])

  const loadLinkedDocs = useCallback(async (noteId: string) => {
    const docs = await window.electronAPI.listLinksForNote(noteId)
    setLinkedDocs(docs)
  }, [])

  const loadLinkedNotes = useCallback(async (kbDocId: string) => {
    const notes = await window.electronAPI.listLinksForDoc(kbDocId)
    setLinkedNotes(notes)
  }, [])

  const addLink = useCallback(async (noteId: string, kbDocId: string) => {
    await window.electronAPI.addLink(noteId, kbDocId)
    await loadLinkedDocs(noteId)
    await loadLinkedNotes(kbDocId)
  }, [loadLinkedDocs, loadLinkedNotes])

  const removeLink = useCallback(
    async (noteId: string, kbDocId: string) => {
      await window.electronAPI.removeLink(noteId, kbDocId)
      await loadLinkedDocs(noteId)
      await loadLinkedNotes(kbDocId)
    },
    [loadLinkedDocs, loadLinkedNotes]
  )

  return {
    linkedDocs,
    linkedNotes,
    loadLinkedDocs,
    loadLinkedNotes,
    addLink,
    removeLink
  }
}
