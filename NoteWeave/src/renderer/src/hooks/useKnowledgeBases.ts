import { useCallback, useEffect, useState } from 'react'
import type { KnowledgeBase, KnowledgeBaseSummary } from '../types'

export function useKnowledgeBases() {
  const [kbs, setKbs] = useState<KnowledgeBaseSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedKb, setSelectedKb] = useState<KnowledgeBase | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadKbs = useCallback(async () => {
    const list = await window.electronAPI.listKnowledgeBases()
    setKbs(list)
  }, [])

  useEffect(() => {
    loadKbs()
  }, [loadKbs])

  useEffect(() => {
    if (!selectedId) {
      setSelectedKb(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    window.electronAPI.getKnowledgeBase(selectedId).then((kb) => {
      if (!cancelled) {
        setSelectedKb(kb)
        setIsLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const createKb = useCallback(
    async (name: string, category: string) => {
      const kb = await window.electronAPI.createKnowledgeBase(name, category)
      await loadKbs()
      setSelectedId(kb.id)
      return kb
    },
    [loadKbs]
  )

  const updateKb = useCallback(
    async (kb: KnowledgeBase) => {
      const updated = await window.electronAPI.updateKnowledgeBase(kb)
      await loadKbs()
      setSelectedKb(updated)
      return updated
    },
    [loadKbs]
  )

  const deleteKb = useCallback(
    async (id: string) => {
      const ok = await window.electronAPI.deleteKnowledgeBase(id)
      if (ok) {
        if (selectedId === id) {
          setSelectedId(null)
          setSelectedKb(null)
        }
        await loadKbs()
      }
      return ok
    },
    [loadKbs, selectedId]
  )

  return {
    kbs,
    selectedId,
    setSelectedId,
    selectedKb,
    isLoading,
    createKb,
    updateKb,
    deleteKb,
    refresh: loadKbs
  }
}
