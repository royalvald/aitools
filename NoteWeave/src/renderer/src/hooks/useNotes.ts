import { useCallback, useEffect, useRef, useState } from 'react'
import type { Note, NoteSummary } from '../types'
import { clearSaveStatus, noteSaveKey, reportSaveStatus } from '../lib/save-state'

export function useNotes() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadNotes = useCallback(async () => {
    const list = await window.electronAPI.listNotes()
    setNotes(list)
  }, [])

  useEffect(() => {
    loadNotes()
  }, [loadNotes])

  useEffect(() => {
    if (!selectedId) {
      setSelectedNote(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    window.electronAPI.getNote(selectedId).then((note) => {
      if (!cancelled) {
        setSelectedNote(note)
        setIsLoading(false)
        if (note) {
          // 刚加载的文档与磁盘一致，视为已保存（时间取后端 updatedAt）
          reportSaveStatus(noteSaveKey(note.id), {
            state: 'saved',
            savedAt: Date.parse(note.updatedAt) || null
          })
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const handleCreate = useCallback(
    async (groupId?: string | null) => {
      const note = await window.electronAPI.createNote(groupId)
      await loadNotes()
      setSelectedId(note.id)
      return note
    },
    [loadNotes]
  )

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 递增版本号：每次内容变化 +1。自动保存完成后仅当期间没有更新的修改才回写「已保存」。
  const dirtyVersionRef = useRef(0)

  const handleSave = useCallback(
    async (note: Note) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      reportSaveStatus(noteSaveKey(note.id), { state: 'saving', savedAt: null })
      const updated = await window.electronAPI.saveNote(note)
      setSelectedNote(updated)
      await loadNotes()
      reportSaveStatus(noteSaveKey(note.id), { state: 'saved', savedAt: Date.now() })
      return updated
    },
    [loadNotes]
  )

  const handleChange = useCallback(
    (partial: Partial<Note>) => {
      if (!selectedNote) return
      const next = { ...selectedNote, ...partial }
      setSelectedNote(next)

      dirtyVersionRef.current += 1
      const version = dirtyVersionRef.current
      reportSaveStatus(noteSaveKey(next.id), { state: 'unsaved', savedAt: null })

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      saveTimeoutRef.current = setTimeout(() => {
        reportSaveStatus(noteSaveKey(next.id), { state: 'saving', savedAt: null })
        window.electronAPI
          .saveNote(next)
          .then((updated) => {
            setSelectedNote(updated)
            loadNotes()
            // 保存期间又产生了新修改：保持「未保存」，等待下一轮自动保存
            if (dirtyVersionRef.current === version) {
              reportSaveStatus(noteSaveKey(next.id), { state: 'saved', savedAt: Date.now() })
            }
          })
          .catch(() => {
            reportSaveStatus(noteSaveKey(next.id), { state: 'unsaved', savedAt: null })
          })
      }, 500)
    },
    [selectedNote, loadNotes]
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const ok = await window.electronAPI.deleteNote(id)
      if (ok) {
        clearSaveStatus(noteSaveKey(id))
        if (selectedId === id) {
          setSelectedId(null)
          setSelectedNote(null)
        }
        await loadNotes()
      }
    },
    [loadNotes, selectedId]
  )

  return {
    notes,
    selectedId,
    setSelectedId,
    selectedNote,
    isLoading,
    createNote: handleCreate,
    saveNote: handleSave,
    changeNote: handleChange,
    deleteNote: handleDelete,
    refresh: loadNotes
  }
}
