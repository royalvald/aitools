import { useCallback, useEffect, useRef, useState } from 'react'
import type { Whiteboard, WhiteboardElement, WhiteboardFrame } from '../types'

export interface UseWhiteboardReturn {
  whiteboard: Whiteboard | null
  isLoading: boolean
  saveNow: () => Promise<void>
  /** REQ-221 更新白板元素（内存 + 防抖落盘） */
  setElements: (updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => void
  /** REQ-224 更新框架（内存 + 防抖落盘） */
  setFrames: (updater: (frames: WhiteboardFrame[]) => WhiteboardFrame[]) => void
  /** REQ-221 更新视口（scale/offset/background），仅内存 + 防抖落盘 */
  setViewport: (partial: Partial<Pick<Whiteboard, 'scale' | 'offsetX' | 'offsetY' | 'background'>>) => void
}

export function useWhiteboard(kbId: string, docId: string): UseWhiteboardReturn {
  const [whiteboard, setWhiteboard] = useState<Whiteboard | null>(null)
  const whiteboardRef = useRef(whiteboard)
  useEffect(() => {
    whiteboardRef.current = whiteboard
  }, [whiteboard])

  const [isLoading, setIsLoading] = useState(false)
  // 防抖落盘定时器
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      const current = whiteboardRef.current
      if (current) {
        void window.electronAPI.saveWhiteboard(current)
      }
    }, 400)
  }, [])

  const loadWhiteboard = useCallback(async () => {
    setIsLoading(true)
    try {
      const saved = await window.electronAPI.getWhiteboard(kbId, docId)
      if (saved) {
        // 兼容旧数据：缺省字段回填
        const normalized: Whiteboard = {
          ...saved,
          elements: Array.isArray(saved.elements) ? (saved.elements as WhiteboardElement[]) : [],
          frames: Array.isArray(saved.frames) ? saved.frames : [],
          scale: typeof saved.scale === 'number' ? saved.scale : 1,
          offsetX: typeof saved.offsetX === 'number' ? saved.offsetX : 0,
          offsetY: typeof saved.offsetY === 'number' ? saved.offsetY : 0,
          background: saved.background ?? 'dot'
        }
        setWhiteboard(normalized)
      } else {
        const now = new Date().toISOString()
        setWhiteboard({
          kbId,
          docId,
          elements: [],
          frames: [],
          scale: 1,
          offsetX: 0,
          offsetY: 0,
          background: 'dot',
          createdAt: now,
          updatedAt: now
        })
      }
    } finally {
      setIsLoading(false)
    }
  }, [kbId, docId])

  useEffect(() => {
    loadWhiteboard()
  }, [loadWhiteboard])

  // 仅负责把内存中的最新白板写入磁盘，不回写 state。
  const persist = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const current = whiteboardRef.current
    if (!current) return
    await window.electronAPI.saveWhiteboard(current)
  }, [])

  const saveNow = useCallback(async () => {
    await persist()
  }, [persist])

  const setElements = useCallback(
    (updater: (elements: WhiteboardElement[]) => WhiteboardElement[]) => {
      setWhiteboard((prev) => {
        if (!prev) return prev
        const now = new Date().toISOString()
        const next = { ...prev, elements: updater(prev.elements), updatedAt: now }
        whiteboardRef.current = next
        scheduleSave()
        return next
      })
    },
    [scheduleSave]
  )

  const setViewport = useCallback(
    (partial: Partial<Pick<Whiteboard, 'scale' | 'offsetX' | 'offsetY' | 'background'>>) => {
      setWhiteboard((prev) => {
        if (!prev) return prev
        const next = { ...prev, ...partial, updatedAt: new Date().toISOString() }
        whiteboardRef.current = next
        scheduleSave()
        return next
      })
    },
    [scheduleSave]
  )

  const setFrames = useCallback(
    (updater: (frames: WhiteboardFrame[]) => WhiteboardFrame[]) => {
      setWhiteboard((prev) => {
        if (!prev) return prev
        const now = new Date().toISOString()
        const next = { ...prev, frames: updater(prev.frames ?? []), updatedAt: now }
        whiteboardRef.current = next
        scheduleSave()
        return next
      })
    },
    [scheduleSave]
  )

  // 卸载时 flush 防抖保存
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        const current = whiteboardRef.current
        if (current) void window.electronAPI.saveWhiteboard(current)
      }
    }
  }, [])

  return {
    whiteboard,
    isLoading,
    saveNow,
    setElements,
    setFrames,
    setViewport
  }
}

