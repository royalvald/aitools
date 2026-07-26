import { useEffect, useRef, useState } from 'react'
import type {
  BaseWhiteboardElement,
  Whiteboard,
  WhiteboardElement,
  WhiteboardFrame,
  WhiteboardFreehand,
  WhiteboardConnector
} from '../types'
import { WhiteboardElementView } from './WhiteboardElementView'
import { WhiteboardInputDialog } from './WhiteboardInputDialog'
import { useConfirm } from './ConfirmDialog'
import {
  clampScale,
  pointsToPath,
  resizeHandlePos,
  resizeRect,
  RESIZE_ANCHORS,
  RESIZE_CURSORS,
  type ResizeAnchor
} from '../lib/whiteboard-canvas'

// REQ-221 无限画布：平移、缩放、背景模式。
// 画布为仅浏览模式：无工具调色板，左键/中键拖拽平移、滚轮缩放，
// 元素（便签/形状/连线/手绘/框架/内容卡片）照常渲染但不可选中/拖动/新建；
// 内容卡片保留点击打开目标的查看交互。

interface CanvasProps {
  whiteboard: Whiteboard
  setElements: (updater: (els: WhiteboardElement[]) => WhiteboardElement[]) => void
  setViewport: (partial: Partial<Pick<Whiteboard, 'scale' | 'offsetX' | 'offsetY' | 'background'>>) => void
  setFrames?: (updater: (frames: WhiteboardFrame[]) => WhiteboardFrame[]) => void
  children?: React.ReactNode // 文档面板等固定内容（绝对定位，由调用方放置）
  /** REQ-223 点击内容卡片跳转（Note/KB Doc） */
  onOpenContentCard?: (kind: 'note' | 'kbDoc', targetId: string, kbId?: string) => void
  /** REQ-226 便签/文本转为待办（行动项） */
  onConvertToTodo?: (text: string) => void
  /** REQ-229 便签/文本插入到关联文档（转为段落） */
  onInsertToDoc?: (text: string) => void
}

export function WhiteboardCanvas({
  whiteboard,
  setElements,
  setViewport,
  setFrames,
  children,
  onOpenContentCard,
  onConvertToTodo,
  onInsertToDoc
}: CanvasProps) {
  const confirm = useConfirm()
  const { scale, offsetX, offsetY, background, elements, frames } = whiteboard
  const viewportRef = useRef<HTMLDivElement>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  // 平移
  const panState = useRef<{ startX: number; startY: number; originOffsetX: number; originOffsetY: number } | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  // REQ-224 框架改名弹窗（应用内输入，替代 window.prompt）
  const [renameFrame, setRenameFrame] = useState<WhiteboardFrame | null>(null)
  // REQ-221 拖拽对齐辅助线
  const [guideLines, setGuideLines] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const ox = offsetX ?? 0
  const oy = offsetY ?? 0

  // 滚轮：Ctrl/Cmd 缩放，普通滚轮平移。
  // React 17+ 根节点 wheel 监听为 passive，onWheel 里 preventDefault 无效，
  // 因此改为在容器上注册原生非 passive 监听。
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const cx = e.clientX - rect.left
        const cy = e.clientY - rect.top
        // 以鼠标位置为锚点缩放
        const oldScale = scale
        const factor = e.deltaY > 0 ? 0.9 : 1.1
        const newScale = clampScale(Math.round(oldScale * factor * 100) / 100)
        // 保持鼠标对应的世界点不动：world = (screen - offset)/scale
        const wx = (cx - ox) / oldScale
        const wy = (cy - oy) / oldScale
        const newOffsetX = cx - wx * newScale
        const newOffsetY = cy - wy * newScale
        setViewport({ scale: newScale, offsetX: newOffsetX, offsetY: newOffsetY })
      } else {
        // 平移：直接调整 offset
        setViewport({ offsetX: ox - e.deltaX, offsetY: oy - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, ox, oy, setViewport])

  // 仅浏览：左键/中键拖拽均为平移画布（原 hand 工具行为）
  const handleViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    panState.current = {
      startX: e.clientX,
      startY: e.clientY,
      originOffsetX: ox,
      originOffsetY: oy
    }
    setIsPanning(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handleViewportPointerMove = (e: React.PointerEvent) => {
    if (panState.current) {
      const dx = e.clientX - panState.current.startX
      const dy = e.clientY - panState.current.startY
      setViewport({
        offsetX: panState.current.originOffsetX + dx,
        offsetY: panState.current.originOffsetY + dy
      })
    }
  }

  const handleViewportPointerUp = (e: React.PointerEvent) => {
    if (panState.current) {
      panState.current = null
      setIsPanning(false)
    }
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const handleChange = (id: string, patch: Partial<WhiteboardElement>) => {
    setElements((els) => {
      const target = els.find((e) => e.id === id)
      // REQ-221 成组移动：当目标元素属于某个 group，且 patch 包含 x/y 位移时，
      // 将相同位移同步应用到同组其它元素（排除连线和手绘）。
      const p = patch as Partial<BaseWhiteboardElement>
      if (
        target &&
        target.type !== 'connector' &&
        target.type !== 'freehand' &&
        (target as BaseWhiteboardElement).groupId &&
        (p.x !== undefined || p.y !== undefined)
      ) {
        const base = target as BaseWhiteboardElement
        const dx = (p.x ?? base.x) - base.x
        const dy = (p.y ?? base.y) - base.y
        const groupId = base.groupId
        return els.map((el) => {
          if (el.id === id) {
            return { ...el, ...patch, updatedAt: new Date().toISOString() } as WhiteboardElement
          }
          if (
            el.type !== 'connector' &&
            el.type !== 'freehand' &&
            (el as BaseWhiteboardElement).groupId === groupId
          ) {
            const b = el as BaseWhiteboardElement
            return {
              ...el,
              x: b.x + dx,
              y: b.y + dy,
              updatedAt: new Date().toISOString()
            } as WhiteboardElement
          }
          return el
        })
      }
      return els.map((el) =>
        el.id === id ? ({ ...el, ...patch, updatedAt: new Date().toISOString() } as WhiteboardElement) : el
      )
    })
  }

  const handleDelete = (id: string) => {
    setElements((els) => els.filter((el) => el.id !== id && !(el.type === 'connector' && (el.from.elementId === id || el.to.elementId === id))))
  }

  const handleSelect = (_id: string, _additive: boolean) => {
    // 仅浏览模式：元素不可选中
  }

  // REQ-222 置顶/置底
  const handleReorder = (id: string, direction: 'front' | 'back') => {
    setElements((els) => {
      if (direction === 'front') {
        const maxZ = els.reduce((m, e) => Math.max(m, e.zIndex ?? 0), 0)
        return els.map((e) => (e.id === id ? ({ ...e, zIndex: maxZ + 1 } as WhiteboardElement) : e))
      }
      const minZ = els.reduce((m, e) => Math.min(m, e.zIndex ?? 0), 0)
      return els.map((e) => (e.id === id ? ({ ...e, zIndex: minZ - 1 } as WhiteboardElement) : e))
    })
  }

  // REQ-221 拖拽对齐辅助线
  const computeGuides = (id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const others = elements.filter((el) => el.id !== id && el.type !== 'connector' && el.type !== 'freehand')
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = []
    const threshold = 4 // 像素容差
    const bCenters = {
      cx: bounds.x + bounds.width / 2,
      cy: bounds.y + bounds.height / 2
    }
    // 计算画布包围盒，辅助线延伸到包围盒范围
    const allBounds = [...others.map((el) => el as BaseWhiteboardElement), bounds]
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const b of allBounds) {
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.width)
      maxY = Math.max(maxY, b.y + b.height)
    }
    if (!Number.isFinite(minX)) return []
    const pad = 80
    minX -= pad
    minY -= pad
    maxX += pad
    maxY += pad

    for (const el of others) {
      const o = el as BaseWhiteboardElement
      const oCenters = {
        cx: o.x + o.width / 2,
        cy: o.y + o.height / 2
      }
      const xs = [
        { v: bounds.x, target: o.x },
        { v: bounds.x + bounds.width, target: o.x + o.width },
        { v: bCenters.cx, target: oCenters.cx }
      ]
      for (const { v, target } of xs) {
        if (Math.abs(v - target) <= threshold) {
          lines.push({ x1: target, y1: minY, x2: target, y2: maxY })
        }
      }
      const ys = [
        { v: bounds.y, target: o.y },
        { v: bounds.y + bounds.height, target: o.y + o.height },
        { v: bCenters.cy, target: oCenters.cy }
      ]
      for (const { v, target } of ys) {
        if (Math.abs(v - target) <= threshold) {
          lines.push({ x1: minX, y1: target, x2: maxX, y2: target })
        }
      }
    }
    // 去重（相近的线合并）
    const unique: typeof lines = []
    for (const line of lines) {
      const isVertical = line.x1 === line.x2
      const existing = unique.find((u) => {
        if (isVertical && u.x1 === u.x2) return Math.abs(u.x1 - line.x1) < 1
        if (!isVertical && u.y1 === u.y2) return Math.abs(u.y1 - line.y1) < 1
        return false
      })
      if (!existing) unique.push(line)
    }
    return unique
  }

  const handleDragStart = (id: string) => setDraggingId(id)
  const handleDragMove = (id: string, bounds: { x: number; y: number; width: number; height: number }) => {
    setGuideLines(computeGuides(id, bounds))
  }
  const handleDragEnd = () => {
    setDraggingId(null)
    setGuideLines([])
  }

  // 背景样式
  const bgStyle = getBackgroundStyle(background ?? 'dot', scale)

  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full overflow-hidden"
      style={{
        background: bgStyle.background,
        cursor: isPanning ? 'grabbing' : 'grab'
      }}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
    >
      {/* 世界层：通过 transform 应用 scale 与 offset */}
      <div
        data-canvas-world
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${ox}px, ${oy}px) scale(${scale})`,
          transformOrigin: '0 0'
        }}
      >
        {/* SVG 层渲染连线（连线坐标是世界坐标） */}
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          style={{ width: 1, height: 1, overflow: 'visible' }}
        >
          <defs>
            <marker id="wb-arrow-end" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" fill="#475569" />
            </marker>
            <marker id="wb-arrow-start" markerWidth="10" markerHeight="10" refX="2" refY="3" orient="auto">
              <path d="M8,0 L0,3 L8,6 Z" fill="#475569" />
            </marker>
          </defs>
          {/* 连线仅渲染（仅浏览模式不可点选） */}
          <g style={{ pointerEvents: 'auto' }}>
            {elements
              .filter((el): el is WhiteboardConnector => el.type === 'connector')
              .map((conn) => (
                <WhiteboardElementView
                  key={conn.id}
                  element={conn}
                  allElements={elements}
                  selected={false}
                  interactive={false}
                  scale={scale}
                  editing={false}
                  onSelect={handleSelect}
                  onChange={handleChange}
                  onStartEdit={() => {}}
                  onEndEdit={() => {}}
                  onDelete={handleDelete}
                  onStartConnect={() => {}}
                  pendingConnectFrom={null}
                  onFinishConnect={() => {}}
                  onReorder={handleReorder}
                  onDragStart={handleDragStart}
                  onDragMove={handleDragMove}
                  onDragEnd={handleDragEnd}
                />
              ))}
          </g>
        </svg>

        {/* 矩形元素层（仅浏览：不可选中/拖动，内容卡片保留点击打开） */}
        {elements
          .filter((el) => el.type !== 'connector' && el.type !== 'freehand')
          .map((el) => (
            <WhiteboardElementView
              key={el.id}
              element={el}
              allElements={elements}
              selected={false}
              interactive={false}
              scale={scale}
              editing={editingId === el.id}
              onSelect={handleSelect}
              onChange={handleChange}
              onStartEdit={(id) => setEditingId(id)}
              onEndEdit={() => setEditingId(null)}
              onDelete={handleDelete}
              onStartConnect={() => {}}
              pendingConnectFrom={null}
              onFinishConnect={() => {}}
              onReorder={handleReorder}
              onDragStart={handleDragStart}
              onDragMove={handleDragMove}
              onDragEnd={handleDragEnd}
              onOpenContentCard={(card) => {
                if (card.targetKind === 'note' && card.targetId) {
                  onOpenContentCard?.('note', card.targetId)
                } else if (card.targetKind === 'kbDoc' && card.targetId) {
                  onOpenContentCard?.('kbDoc', card.targetId, card.kbId)
                } else if (card.targetKind === 'image' && card.url) {
                  window.electronAPI.openImageExternally(card.url)
                }
              }}
              onConvertToTodo={onConvertToTodo}
              onInsertToDoc={onInsertToDoc}
            />
          ))}

        {/* REQ-221 拖拽对齐辅助线 */}
        {guideLines.length > 0 && (
          <svg
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
            style={{ width: 1, height: 1, overflow: 'visible' }}
          >
            {guideLines.map((line, i) => (
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke="var(--color-accent)"
                strokeWidth={1}
                strokeDasharray="4 4"
                opacity={0.7}
              />
            ))}
          </svg>
        )}

        {/* REQ-224 框架（Frame）：背景层，仅渲染展示（仅浏览模式不可拖拽/改名/删除） */}
        {(frames ?? []).map((frame, i) => (
          <FrameView
            key={frame.id}
            frame={frame}
            index={i}
            scale={scale}
            setFrames={undefined}
            onRequestRename={() => setRenameFrame(frame)}
            onRequestDelete={async () => {
              if (!setFrames) return
              const ok = await confirm({
                title: '删除框架',
                description: '删除此框架？（元素保留）',
                confirmText: '删除',
                danger: true
              })
              if (ok) {
                setFrames((fs) => fs.filter((f) => f.id !== frame.id))
              }
            }}
          />
        ))}

        {/* REQ-227 手绘图层（底层）：渲染已保存的 freehand 路径（旧数据兼容，仅展示不可新建） */}
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          style={{ width: 1, height: 1, overflow: 'visible' }}
        >
          {elements
            .filter((el): el is WhiteboardFreehand => el.type === 'freehand')
            .map((f) => (
              <path
                key={f.id}
                d={pointsToPath(f.points)}
                fill="none"
                stroke={f.color}
                strokeWidth={f.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
        </svg>

        {/* 调用方提供的固定内容（如文档面板），位于世界层，随画布平移/缩放 */}
        {children}
      </div>

      {/* 框架改名弹窗（应用内输入，替代 window.prompt） */}
      {renameFrame && setFrames && (
        <WhiteboardInputDialog
          title="框架名称"
          defaultValue={renameFrame.name}
          placeholder="请输入框架名称"
          onSubmit={(name) => {
            setFrames((fs) => fs.map((f) => (f.id === renameFrame.id ? { ...f, name } : f)))
          }}
          onClose={() => setRenameFrame(null)}
        />
      )}
    </div>
  )
}

// REQ-224 单个框架的渲染：边缘拖拽移动、8 点缩放、改名/删除仅在传入 setFrames 时可用（仅浏览模式不传入）。
function FrameView({
  frame,
  index,
  scale,
  setFrames,
  onRequestRename,
  onRequestDelete
}: {
  frame: WhiteboardFrame
  index: number
  scale: number
  setFrames?: (updater: (frames: WhiteboardFrame[]) => WhiteboardFrame[]) => void
  onRequestRename: () => void
  onRequestDelete: () => void
}) {
  const dragRef = useRef<{
    mode: 'move' | 'resize'
    anchor?: ResizeAnchor
    startWorld: { x: number; y: number }
    origin: { x: number; y: number; width: number; height: number }
  } | null>(null)

  const toWorld = (e: React.PointerEvent) => {
    const layer = (e.currentTarget as HTMLElement).closest('[data-canvas-world]') as HTMLElement | null
    const rect = layer?.getBoundingClientRect()
    const sx = rect ? e.clientX - rect.left : e.clientX
    const sy = rect ? e.clientY - rect.top : e.clientY
    return { x: sx / scale, y: sy / scale }
  }

  const handlePointerDown = (e: React.PointerEvent, mode: 'move' | 'resize', anchor?: ResizeAnchor) => {
    if (e.button !== 0 || !setFrames) return
    e.stopPropagation()
    dragRef.current = {
      mode,
      anchor,
      startWorld: toWorld(e),
      origin: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const ds = dragRef.current
    if (!ds || !setFrames) return
    const world = toWorld(e)
    const dx = world.x - ds.startWorld.x
    const dy = world.y - ds.startWorld.y
    if (ds.mode === 'move') {
      const nx = Math.round(ds.origin.x + dx)
      const ny = Math.round(ds.origin.y + dy)
      setFrames((fs) => fs.map((f) => (f.id === frame.id ? { ...f, x: nx, y: ny } : f)))
    } else if (ds.anchor) {
      const next = resizeRect(ds.origin, ds.anchor, dx, dy, e.shiftKey, 80)
      setFrames((fs) => fs.map((f) => (f.id === frame.id ? { ...f, ...next } : f)))
    }
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const color = frame.color ?? '#c7d2fe'
  const edge = Math.max(6, 8 / scale) // 边缘拖拽带厚度（世界像素，屏幕上约 8px）
  const handleSize = 8 / scale
  const interactive = !!setFrames

  return (
    <div
      className="group pointer-events-none absolute"
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        zIndex: 0
      }}
    >
      <div
        className="absolute inset-0 rounded-lg border-2"
        style={{ borderColor: color, background: color + '15' }}
      />
      {/* 名称标签：框架内顶部（原 -top-6 会被画布顶部裁切） */}
      <div className="pointer-events-auto absolute left-1 top-1 flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
        <span
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-primary-foreground)]"
          style={{ background: frame.color ?? 'var(--color-accent)' }}
        >
          {index + 1}. {frame.name}
        </span>
        {interactive && (
          <>
            <button
              onClick={onRequestRename}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 rounded bg-[var(--color-surface)] px-1 text-[10px] shadow hover:bg-[var(--color-surface-2)]"
            >
              改名
            </button>
            <button
              onClick={onRequestDelete}
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 rounded bg-[var(--color-danger)] px-1 text-[10px] text-[var(--color-primary-foreground)] hover:bg-[var(--color-danger)]"
            >
              删
            </button>
          </>
        )}
      </div>
      {interactive && (
        <>
          {/* 边缘拖拽带：拖动移动框架 */}
          <div
            className="absolute left-0 right-0 top-0 cursor-move"
            style={{ height: edge, pointerEvents: 'auto' }}
            onPointerDown={(e) => handlePointerDown(e, 'move')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <div
            className="absolute bottom-0 left-0 right-0 cursor-move"
            style={{ height: edge, pointerEvents: 'auto' }}
            onPointerDown={(e) => handlePointerDown(e, 'move')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <div
            className="absolute bottom-0 left-0 top-0 cursor-move"
            style={{ width: edge, pointerEvents: 'auto' }}
            onPointerDown={(e) => handlePointerDown(e, 'move')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          <div
            className="absolute bottom-0 right-0 top-0 cursor-move"
            style={{ width: edge, pointerEvents: 'auto' }}
            onPointerDown={(e) => handlePointerDown(e, 'move')}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          {/* 缩放控制点：4 角 + 4 边中点（Shift 等比） */}
          {RESIZE_ANCHORS.map((a) => {
            const pos = resizeHandlePos(frame, a)
            return (
              <div
                key={a}
                onPointerDown={(e) => handlePointerDown(e, 'resize', a)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                className="absolute opacity-0 transition-opacity group-hover:opacity-100"
                style={{
                  left: pos.x - handleSize / 2,
                  top: pos.y - handleSize / 2,
                  width: handleSize,
                  height: handleSize,
                  background: 'var(--color-accent)',
                  borderRadius: 2,
                  cursor: RESIZE_CURSORS[a],
                  pointerEvents: 'auto'
                }}
              />
            )
          })}
        </>
      )}
    </div>
  )
}

// REQ-221 背景模式：点阵 / 网格 / 空白（颜色走 --color-canvas-* 主题变量，跟随亮暗主题）
function getBackgroundStyle(mode: 'dot' | 'grid' | 'blank', scale: number) {
  const size = 24 * scale
  if (mode === 'blank') {
    return { background: 'var(--color-canvas-bg)' }
  }
  if (mode === 'dot') {
    return {
      background: `var(--color-canvas-bg) radial-gradient(circle, var(--color-canvas-dot) 1px, transparent 1px)`,
      backgroundSize: `${size}px ${size}px`
    }
  }
  // grid
  return {
    background: `var(--color-canvas-bg)`,
    backgroundImage: `linear-gradient(var(--color-canvas-grid) 1px, transparent 1px), linear-gradient(90deg, var(--color-canvas-grid) 1px, transparent 1px)`,
    backgroundSize: `${size}px ${size}px`
  }
}
