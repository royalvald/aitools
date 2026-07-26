import { useCallback, useEffect, useState } from 'react'
import type { KbDocAnnotation } from '../types'

/**
 * 管理指定 KB Doc 的批注列表。
 *
 * 与文档内容的「防抖自动保存」不同，批注是离散动作（添加 / 编辑 / 删除），
 * 因此采用即时保存：每次操作直接落盘并刷新列表，不再额外防抖。
 * 增删后会通过 onMutation 回调通知父组件刷新文档列表中的批注数量。
 */
export function useKbDocAnnotations(
  kbId: string | null,
  docId: string | null,
  onMutation?: () => void
) {
  const [annotations, setAnnotations] = useState<KbDocAnnotation[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const load = useCallback(async () => {
    if (!kbId || !docId) {
      setAnnotations([])
      return
    }
    setIsLoading(true)
    try {
      const list = await window.electronAPI.listAnnotations(kbId, docId)
      setAnnotations(list)
    } finally {
      setIsLoading(false)
    }
  }, [kbId, docId])

  useEffect(() => {
    load()
  }, [load])

  const create = useCallback(
    async (
      text: string,
      startOffset: number,
      endOffset: number,
      content: string
    ): Promise<KbDocAnnotation> => {
      if (!kbId || !docId) throw new Error('未选定文档，无法创建批注')
      const annotation = await window.electronAPI.createAnnotation(
        kbId,
        docId,
        text,
        startOffset,
        endOffset,
        content
      )
      await load()
      onMutation?.()
      return annotation
    },
    [kbId, docId, load, onMutation]
  )

  const update = useCallback(
    async (annotation: KbDocAnnotation): Promise<KbDocAnnotation> => {
      const updated = await window.electronAPI.updateAnnotation(annotation)
      await load()
      onMutation?.()
      return updated
    },
    [load, onMutation]
  )

  const deleteAnnotation = useCallback(
    async (id: string): Promise<boolean> => {
      if (!kbId || !docId) return false
      const ok = await window.electronAPI.deleteAnnotation(kbId, docId, id)
      if (ok) {
        await load()
        onMutation?.()
      }
      return ok
    },
    [kbId, docId, load, onMutation]
  )

  // REQ-015：批注回复
  const addReply = useCallback(
    async (annotation: KbDocAnnotation, content: string): Promise<KbDocAnnotation> => {
      const updated = await window.electronAPI.addAnnotationReply(annotation, content)
      setAnnotations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
      onMutation?.()
      return updated
    },
    [onMutation]
  )

  const deleteReply = useCallback(
    async (annotation: KbDocAnnotation, replyId: string): Promise<KbDocAnnotation> => {
      const updated = await window.electronAPI.deleteAnnotationReply(annotation, replyId)
      setAnnotations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
      onMutation?.()
      return updated
    },
    [onMutation]
  )

  return { annotations, isLoading, load, create, update, deleteAnnotation, addReply, deleteReply }
}
