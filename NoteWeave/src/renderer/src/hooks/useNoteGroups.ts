import { useCallback, useEffect, useState } from 'react'
import type { NoteGroup } from '../types'

export function useNoteGroups() {
  const [groups, setGroups] = useState<NoteGroup[]>([])

  const loadGroups = useCallback(async () => {
    const list = await window.electronAPI.listNoteGroups()
    setGroups(list)
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  const createGroup = useCallback(
    async (name: string, parentId: string | null) => {
      const group = await window.electronAPI.createNoteGroup(name, parentId)
      await loadGroups()
      return group
    },
    [loadGroups]
  )

  const updateGroup = useCallback(
    async (id: string, name: string) => {
      const group = await window.electronAPI.updateNoteGroup(id, name)
      await loadGroups()
      return group
    },
    [loadGroups]
  )

  const deleteGroup = useCallback(
    async (id: string) => {
      const ok = await window.electronAPI.deleteNoteGroup(id)
      if (ok) {
        await loadGroups()
      }
      return ok
    },
    [loadGroups]
  )

  return {
    groups,
    createGroup,
    updateGroup,
    deleteGroup,
    refresh: loadGroups
  }
}
