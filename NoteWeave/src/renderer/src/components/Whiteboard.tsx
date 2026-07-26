import { useCallback, useEffect, useRef, useState } from 'react'
import { WhiteboardToolbar } from './WhiteboardToolbar'
import { WhiteboardCanvas } from './WhiteboardCanvas'
import { FramePresentation } from './FramePresentation'
import { WhiteboardMinimap } from './WhiteboardMinimap'
import { whiteboardToSvg, whiteboardBounds } from '../../../shared/whiteboard-export'
import type { WhiteboardElement } from '../types'
import { MilkdownEditor } from './MilkdownEditor'
import { NoteEditor } from './NoteEditor'
import { NotePreview } from './NotePreview'
import { useWhiteboard } from '../hooks/useWhiteboard'
import { clampScale } from '../lib/whiteboard-canvas'
import type { KnowledgeBaseDoc, Whiteboard } from '../types'

interface WhiteboardProps {
  doc: KnowledgeBaseDoc
  editableContent?: boolean
  /** REQ-223 点击内容卡片跳转（默认在新窗口打开） */
  onOpenContentCard?: (kind: 'note' | 'kbDoc', targetId: string, kbId?: string) => void
}

export function Whiteboard({ doc, editableContent = false, onOpenContentCard }: WhiteboardProps) {
  const { whiteboard, isLoading, saveNow, setElements, setFrames, setViewport } = useWhiteboard(doc.kbId, doc.id)

  const [liveDocContent, setLiveDocContent] = useState(doc.content)
  const [sourceMode, setSourceMode] = useState(false)
  const [presentingFrames, setPresentingFrames] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 })
  const canvasRef = useRef<HTMLDivElement>(null)
  const docSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 跟踪最新的 doc / 文档内容，供卸载时立即 flush 保存读取（cleanup 闭包无法读到最新 state）。
  const docRef = useRef(doc)
  docRef.current = doc
  const liveDocContentRef = useRef(liveDocContent)
  liveDocContentRef.current = liveDocContent

  // 撤销/重做：内存级历史栈（元素数组快照，上限 HISTORY_LIMIT 步）。
  // 连续变更（如拖拽过程中逐帧的 setElements）按 600ms 空闲合并为一个历史步：
  // 首次变更时记录变更前快照，空闲后统一入栈。
  const HISTORY_LIMIT = 50
  const pastRef = useRef<WhiteboardElement[][]>([])
  const futureRef = useRef<WhiteboardElement[][]>([])
  const pendingSnapshotRef = useRef<WhiteboardElement[] | null>(null)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // whiteboard 的最新引用（undo/redo 在事件回调里读取，避免闭包过期）
  const whiteboardRef = useRef(whiteboard)
  whiteboardRef.current = whiteboard
  // 历史栈尺寸变化（undo/redo/合并落栈）时触发重渲染，刷新按钮禁用态
  const [historyVersion, setHistoryVersion] = useState(0)

  const flushPendingSnapshot = useCallback(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = null
    }
    if (pendingSnapshotRef.current) {
      pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), pendingSnapshotRef.current]
      pendingSnapshotRef.current = null
      setHistoryVersion((v) => v + 1)
    }
  }, [])

  // 包装 setElements：所有元素变更经此入历史栈
  const setElementsWithHistory = useCallback(
    (updater: (els: WhiteboardElement[]) => WhiteboardElement[]) => {
      // 新的编辑使重做栈失效
      futureRef.current = []
      setElements((prev) => {
        if (!pendingSnapshotRef.current) pendingSnapshotRef.current = prev
        return updater(prev)
      })
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
      pendingTimerRef.current = setTimeout(flushPendingSnapshot, 600)
    },
    [setElements, flushPendingSnapshot]
  )

  const undo = useCallback(() => {
    flushPendingSnapshot()
    const snapshot = pastRef.current[pastRef.current.length - 1]
    const current = whiteboardRef.current
    if (!snapshot || !current) return
    pastRef.current = pastRef.current.slice(0, -1)
    futureRef.current = [...futureRef.current, current.elements]
    setElements(() => snapshot)
    setHistoryVersion((v) => v + 1)
  }, [setElements, flushPendingSnapshot])

  const redo = useCallback(() => {
    flushPendingSnapshot()
    const snapshot = futureRef.current[futureRef.current.length - 1]
    const current = whiteboardRef.current
    if (!snapshot || !current) return
    futureRef.current = futureRef.current.slice(0, -1)
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), current.elements]
    setElements(() => snapshot)
    setHistoryVersion((v) => v + 1)
  }, [setElements, flushPendingSnapshot])

  // Ctrl+Z 撤销 / Ctrl+Shift+Z、Ctrl+Y 重做（编辑输入框内不拦截，保留编辑器自身撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  useEffect(() => {
    setLiveDocContent(doc.content)
  }, [doc.content])

  // 立即把当前文档内容写盘并清除挂起的防抖定时器；返回保存 Promise（无变化时立即 resolve）。
  const flushDocSave = useCallback(async () => {
    if (docSaveTimeoutRef.current) {
      clearTimeout(docSaveTimeoutRef.current)
      docSaveTimeoutRef.current = null
    }
    const current = docRef.current
    // 仅当用户实际改动过内容时才保存，避免无谓写入。
    if (current && liveDocContentRef.current !== current.content) {
      await window.electronAPI.saveKbDoc({ ...current, content: liveDocContentRef.current })
    }
  }, [])

  // 卸载时（如切回文档视图）立即 flush 文档内容保存。
  useEffect(() => {
    return () => {
      void flushDocSave()
      void saveNow()
    }
  }, [saveNow, flushDocSave])

  // 跟踪画布视口尺寸，用于迷你地图
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const update = () => {
      setViewportSize({ width: el.clientWidth, height: el.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleDocChange = useCallback((value: string) => {
    setLiveDocContent(value)
    if (docSaveTimeoutRef.current) {
      clearTimeout(docSaveTimeoutRef.current)
    }
    docSaveTimeoutRef.current = setTimeout(() => {
      docSaveTimeoutRef.current = null
      void window.electronAPI.saveKbDoc({ ...docRef.current, content: value })
    }, 800)
  }, [])

  if (isLoading || !whiteboard) {
    return <div className="flex h-full items-center justify-center text-[var(--color-muted-foreground)]">加载白板…</div>
  }

  const scale = whiteboard.scale

  // 撤销/重做按钮可用态（historyVersion 仅用于触发重渲染刷新栈尺寸读取）
  void historyVersion
  const canUndo = pastRef.current.length > 0 || pendingSnapshotRef.current !== null
  const canRedo = futureRef.current.length > 0

  const handleZoomToFit = () => {
    setViewport({ scale: 1, offsetX: 0, offsetY: 0 })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <WhiteboardToolbar
        scale={scale}
        onScaleChange={(s) => setViewport({ scale: clampScale(Math.round(s * 100) / 100) })}
        editableContent={editableContent}
        sourceMode={sourceMode}
        onToggleSourceMode={() => setSourceMode((v) => !v)}
        onZoomToFit={handleZoomToFit}
        frameCount={whiteboard.frames?.length ?? 0}
        onPresentFrames={() => setPresentingFrames(true)}
        onExportFramesPdf={async () => {
          // 导出框架为 PDF：通过离屏渲染每帧的 SVG 数据 URL，主进程拼页打印
          const frames = [...(whiteboard.frames ?? [])].sort((a, b) => a.order - b.order)
          if (frames.length === 0) return
          // 复用演示态：生成每帧的 SVG 快照字符串数组
          // 简化实现：把每帧的元素 + 框架序列化为 SVG 字符串，传给主进程
          const svgs = frames.map((f) => serializeFrameToSvg(whiteboard, f))
          await window.electronAPI.exportWhiteboardFramesPdf(doc.kbId, doc.id, svgs)
        }}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onExport={async (format) => {
          if (format === 'png') {
            // SVG → image → canvas → dataURL → 主进程写盘
            const svg = whiteboardToSvg(whiteboard)
            const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
            const url = URL.createObjectURL(svgBlob)
            const img = new Image()
            img.onload = async () => {
              const b = whiteboardBounds(whiteboard)
              const scale = 2 // 2x 清晰度
              const canvas = document.createElement('canvas')
              canvas.width = (b.width + 48) * scale
              canvas.height = (b.height + 48) * scale
              const ctx = canvas.getContext('2d')
              if (!ctx) return
              ctx.fillStyle = '#fff'
              ctx.fillRect(0, 0, canvas.width, canvas.height)
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
              URL.revokeObjectURL(url)
              const dataUrl = canvas.toDataURL('image/png')
              await window.electronAPI.exportWhiteboard(whiteboard, 'png', dataUrl)
            }
            img.src = url
          } else {
            await window.electronAPI.exportWhiteboard(whiteboard, format)
          }
        }}
      />

      <div ref={canvasRef} className="relative flex-1">
        {viewportSize.width > 0 && viewportSize.height > 0 && (
          <div className="absolute bottom-4 right-4 z-30">
            <WhiteboardMinimap
              whiteboard={whiteboard}
              viewportWidth={viewportSize.width}
              viewportHeight={viewportSize.height}
              onPan={(wx, wy) => {
                // 点击迷你地图：以该点为中心重新定位视口
                const cx = viewportSize.width / 2
                const cy = viewportSize.height / 2
                setViewport({
                  offsetX: cx - wx * whiteboard.scale,
                  offsetY: cy - wy * whiteboard.scale
                })
              }}
            />
          </div>
        )}
        <WhiteboardCanvas
          whiteboard={whiteboard}
          setElements={setElementsWithHistory}
          setFrames={setFrames}
          setViewport={setViewport}
          onOpenContentCard={
            onOpenContentCard ??
            ((kind, targetId, kbId) => {
              // 默认在新窗口打开目标
              window.electronAPI.openTargetInNewWindow(
                kind === 'kbDoc'
                  ? { kind: 'kbDoc', id: targetId, kbId: kbId ?? '' }
                  : { kind: 'note', id: targetId }
              )
            })
          }
          onConvertToTodo={async (text) => {
            // 便签/文本转为待办，关联到当前文档
            await window.electronAPI.createTodo(
              text.trim() || '白板行动项',
              '',
              'kbDoc',
              doc.id,
              doc.kbId
            )
          }}
          onInsertToDoc={(text) => {
            // REQ-229 便签转段落：追加到关联文档正文
            const para = `\n\n${text.trim()}\n`
            handleDocChange((liveDocContentRef.current ?? doc.content) + para)
          }}
        >
          {/* 文档面板：作为固定内容覆盖在画布之上（视口层，独立于世界坐标变换），
              保持原有「文档展示/编辑面板」体验，同时画布可在其周围/之下自由排布元素。 */}
          <DocPanel
            doc={doc}
            editableContent={editableContent}
            sourceMode={sourceMode}
            liveDocContent={liveDocContent}
            onDocChange={handleDocChange}
          />
        </WhiteboardCanvas>
      </div>

      {presentingFrames && (
        <FramePresentation
          whiteboard={whiteboard}
          frames={whiteboard.frames ?? []}
          onClose={() => setPresentingFrames(false)}
        />
      )}
    </div>
  )
}

// REQ-224 把单帧内容序列化为 SVG 字符串（供导出 PDF 用，主进程拼页打印）。
// 简化：渲染框架矩形 + 框内矩形元素（便签/文本/形状）的几何与文本；连线/手绘跳过。
function serializeFrameToSvg(wb: Whiteboard, frame: { x: number; y: number; width: number; height: number; color?: string }): string {
  const x0 = frame.x
  const y0 = frame.y
  const w = frame.width
  const h = frame.height
  const parts: string[] = []
  parts.push(
    `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" rx="8" fill="#ffffff" stroke="${frame.color ?? '#6366f1'}" stroke-width="3"/>`
  )
  for (const el of wb.elements) {
    if (el.type === 'connector' || el.type === 'freehand') continue
    const b = el as { type: string; x: number; y: number; width: number; height: number }
    // 仅绘制与 frame 相交的元素
    if (b.x + b.width < x0 || b.x > x0 + w || b.y + b.height < y0 || b.y > y0 + h) continue
    const text = (el as { text?: string }).text ?? ''
    if (el.type === 'sticky') {
      const c = (el as { color?: string }).color ?? '#fef9c3'
      parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="4" fill="${c}"/>`)
    } else if (el.type === 'shape') {
      parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="4" fill="#fff" stroke="#475569"/>`)
    } else {
      parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="2" fill="#fff" stroke="#cbd5e1"/>`)
    }
    if (text) {
      const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      parts.push(
        `<text x="${b.x + 8}" y="${b.y + 20}" font-size="14" fill="#1e293b">${safe.slice(0, 50)}</text>`
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}">${parts.join(
    ''
  )}</svg>`
}

// 文档面板：位于画布世界坐标系（原点附近），随画布平移/缩放，
// 成为画布上的一个「内容卡片」，周围可放置便签等元素。
function DocPanel({
  doc,
  editableContent,
  sourceMode,
  liveDocContent,
  onDocChange
}: {
  doc: KnowledgeBaseDoc
  editableContent: boolean
  sourceMode: boolean
  liveDocContent: string
  onDocChange: (v: string) => void
}) {
  // 阻止文档面板上的指针事件冒泡到画布（避免在面板上拖拽时触发框选/平移）
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  return (
    <div
      className="absolute"
      style={{ left: 32, top: 32, width: 960 }}
      onPointerDown={stop}
    >
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <h2 className="mb-4 text-xl font-semibold text-[var(--color-foreground)]">{doc.name}</h2>
        {editableContent ? (
          sourceMode ? (
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-muted-foreground)]">Markdown 源码</label>
                <NoteEditor value={liveDocContent} onChange={onDocChange} height={300} preview="edit" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-muted-foreground)]">渲染预览</label>
                <div className="markdown-body min-h-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
                  <NotePreview markdown={liveDocContent} />
                </div>
              </div>
            </div>
          ) : (
            <MilkdownEditor key={doc.id} value={liveDocContent} onChange={onDocChange} />
          )
        ) : (
          <div className="markdown-body min-h-[200px] max-w-none select-text">
            <NotePreview markdown={doc.content} />
          </div>
        )}
      </div>
    </div>
  )
}
