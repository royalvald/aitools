import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnowledgeBaseDoc, KnowledgeBaseDocSummary } from '../types'
import { clearSaveStatus, kbDocSaveKey, reportSaveStatus } from '../lib/save-state'

export function useKnowledgeBaseDocs(kbId: string | null) {
  const [docs, setDocs] = useState<KnowledgeBaseDocSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeBaseDoc | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadDocs = useCallback(async () => {
    if (!kbId) {
      setDocs([])
      return
    }
    const list = await window.electronAPI.listKbDocs(kbId)
    setDocs(list)
  }, [kbId])

  useEffect(() => {
    setSelectedId(null)
    setSelectedDoc(null)
  }, [kbId])

  useEffect(() => {
    loadDocs()
  }, [loadDocs])

  useEffect(() => {
    if (!kbId || !selectedId) {
      setSelectedDoc(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    window.electronAPI.getKbDoc(kbId, selectedId).then((doc) => {
      if (!cancelled) {
        setSelectedDoc(doc)
        setIsLoading(false)
        if (doc) {
          // 刚加载的文档与磁盘一致，视为已保存（时间取后端 updatedAt）
          reportSaveStatus(kbDocSaveKey(doc.id), {
            state: 'saved',
            savedAt: Date.parse(doc.updatedAt) || null
          })
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [kbId, selectedId])

  const createDoc = useCallback(
    async (name: string, parentId?: string | null) => {
      if (!kbId) return null
      const doc = await window.electronAPI.createKbDoc(kbId, name)
      // REQ-006：创建后若有 parentId，立刻移动到该父节点下。
      if (parentId) {
        const siblings = (await window.electronAPI.listKbDocs(kbId)).filter(
          (d) => (d.parentId ?? null) === parentId
        )
        await window.electronAPI.moveKbDoc(kbId, doc.id, parentId, siblings.length)
      }
      await loadDocs()
      setSelectedId(doc.id)
      const fresh = await window.electronAPI.getKbDoc(kbId, doc.id)
      setSelectedDoc(fresh)
      return fresh ?? doc
    },
    [kbId, loadDocs]
  )

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 递增版本号：每次内容变化 +1。自动保存完成后仅当期间没有更新的修改才回写「已保存」。
  const dirtyVersionRef = useRef(0)

  const saveDoc = useCallback(
    async (doc: KnowledgeBaseDoc) => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      reportSaveStatus(kbDocSaveKey(doc.id), { state: 'saving', savedAt: null })
      const updated = await window.electronAPI.saveKbDoc(doc)
      setSelectedDoc(updated)
      await loadDocs()
      reportSaveStatus(kbDocSaveKey(doc.id), { state: 'saved', savedAt: Date.now() })
      return updated
    },
    [loadDocs]
  )

  const changeDoc = useCallback(
    (partial: Partial<KnowledgeBaseDoc>) => {
      if (!selectedDoc) return
      const next = { ...selectedDoc, ...partial }
      setSelectedDoc(next)

      dirtyVersionRef.current += 1
      const version = dirtyVersionRef.current
      reportSaveStatus(kbDocSaveKey(next.id), { state: 'unsaved', savedAt: null })

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      saveTimeoutRef.current = setTimeout(() => {
        reportSaveStatus(kbDocSaveKey(next.id), { state: 'saving', savedAt: null })
        window.electronAPI
          .saveKbDoc(next)
          .then((updated) => {
            setSelectedDoc(updated)
            loadDocs()
            // 保存期间又产生了新修改：保持「未保存」，等待下一轮自动保存
            if (dirtyVersionRef.current === version) {
              reportSaveStatus(kbDocSaveKey(next.id), { state: 'saved', savedAt: Date.now() })
            }
          })
          .catch(() => {
            reportSaveStatus(kbDocSaveKey(next.id), { state: 'unsaved', savedAt: null })
          })
      }, 500)
    },
    [selectedDoc, loadDocs]
  )

  const deleteDoc = useCallback(
    async (docId: string) => {
      if (!kbId) return false
      const ok = await window.electronAPI.deleteKbDoc(kbId, docId)
      if (ok) {
        clearSaveStatus(kbDocSaveKey(docId))
        if (selectedId === docId) {
          setSelectedId(null)
          setSelectedDoc(null)
        }
        await loadDocs()
      }
      return ok
    },
    [kbId, loadDocs, selectedId]
  )

  // REQ-006：移动文档到新父节点（null=顶层）。移动后重新加载列表。
  const moveDoc = useCallback(
    async (docId: string, parentId: string | null): Promise<boolean> => {
      if (!kbId) return false
      const list = await window.electronAPI.listKbDocs(kbId)
      const siblings = list.filter(
        (d) => d.id !== docId && (d.parentId ?? null) === parentId
      )
      const order = siblings.length
      const ok = await window.electronAPI.moveKbDoc(kbId, docId, parentId, order)
      if (ok) await loadDocs()
      return ok
    },
    [kbId, loadDocs]
  )

  // REQ-006：删除父节点时级联删除其全部子孙文档。
  const deleteDocCascade = useCallback(
    async (docId: string): Promise<void> => {
      if (!kbId) return
      const list = await window.electronAPI.listKbDocs(kbId)
      const childrenOf = (pid: string): string[] => {
        const direct = list.filter((d) => (d.parentId ?? null) === pid).map((d) => d.id)
        return direct.concat(...direct.map(childrenOf))
      }
      const toDelete = [docId, ...childrenOf(docId)]
      for (const id of toDelete) {
        await window.electronAPI.deleteKbDoc(kbId, id)
        clearSaveStatus(kbDocSaveKey(id))
      }
      if (selectedId && toDelete.includes(selectedId)) {
        setSelectedId(null)
        setSelectedDoc(null)
      }
      await loadDocs()
    },
    [kbId, loadDocs, selectedId]
  )

  // 重新加载指定文档：若它是当前选中文档，则刷新其内容；同时刷新列表摘要。
  // 用于展示窗口修改文档后通知主窗口同步最新数据。
  const reloadDoc = useCallback(
    async (targetKbId: string, docId: string) => {
      if (targetKbId !== kbId) return
      await loadDocs()
      if (selectedId === docId) {
        const fresh = await window.electronAPI.getKbDoc(targetKbId, docId)
        setSelectedDoc(fresh)
      }
    },
    [kbId, loadDocs, selectedId]
  )

  return {
    docs,
    selectedId,
    setSelectedId,
    selectedDoc,
    isLoading,
    createDoc,
    saveDoc,
    changeDoc,
    deleteDoc,
    moveDoc,
    deleteDocCascade,
    reloadDoc,
    refresh: loadDocs
  }
}
