import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import type { Whiteboard, WhiteboardElement, WhiteboardFrame, BaseWhiteboardElement, WhiteboardFreehand } from '../types'
import { WhiteboardElementView } from './WhiteboardElementView'
import { connectorEndpoints, freehandBounds, pointsToPath, rectsIntersect } from '../lib/whiteboard-canvas'

// REQ-224 框架演示模式：按框架 order 顺序全屏切换。
// 每帧把框架矩形内的元素绘制到屏幕中央并自适应缩放。
interface FramePresentationProps {
  whiteboard: Whiteboard
  frames: WhiteboardFrame[]
  onClose: () => void
}

export function FramePresentation({ whiteboard, frames, onClose }: FramePresentationProps) {
  const ordered = useMemo(() => [...frames].sort((a, b) => a.order - b.order), [frames])
  const [idx, setIdx] = useState(0)
  const frame = ordered[idx]
  // 屏幕尺寸：跟随窗口 resize（原先直接读 window.innerWidth，无监听）
  const [screen, setScreen] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = () => setScreen({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, ordered.length - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered.length, onClose])

  if (ordered.length === 0) {
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--color-foreground)] text-[var(--color-primary-foreground)]">
        <button className="absolute right-6 top-6" onClick={onClose}>
          <X />
        </button>
        <div>没有框架可演示</div>
      </div>
    )
  }

  // 计算自适应缩放：把 frame 宽高适配到屏幕 85%
  const screenW = screen.w
  const screenH = screen.h
  const padW = screenW * 0.85
  const padH = screenH * 0.85
  const scale = Math.min(padW / frame.width, padH / frame.height)
  // 居中偏移（屏幕中心 - frame 中心 * scale）
  const offsetX = (screenW - frame.width * scale) / 2 - frame.x * scale
  const offsetY = (screenH - frame.height * scale) / 2 - frame.y * scale

  // 过滤出在 frame 矩形内的可见元素：
  // 矩形元素按自身包围盒；手绘按 points 包围盒；连线按两端点包围盒（原先两者被直接排除，演示中丢失）
  const frameRect = { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
  const inFrame = (el: WhiteboardElement): boolean => {
    if (el.type === 'connector') {
      const { from, to } = connectorEndpoints(el, whiteboard.elements)
      const bounds = {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y)
      }
      return rectsIntersect(bounds, frameRect)
    }
    if (el.type === 'freehand') {
      return rectsIntersect(freehandBounds(el as WhiteboardFreehand), frameRect)
    }
    const b = el as BaseWhiteboardElement
    return rectsIntersect({ x: b.x, y: b.y, width: b.width, height: b.height }, frameRect)
  }
  const visible = whiteboard.elements.filter(inFrame)
  const visibleConnectors = visible.filter((el) => el.type === 'connector')
  const visibleFreehands = visible.filter((el): el is WhiteboardFreehand => el.type === 'freehand')
  const visibleRects = visible.filter((el) => el.type !== 'connector' && el.type !== 'freehand')

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-[var(--color-foreground)]">
      <button className="absolute right-6 top-6 z-10 text-[var(--color-primary-foreground)]/70 hover:text-[var(--color-primary-foreground)]" onClick={onClose} title="退出 (Esc)">
        <X />
      </button>
      <div className="absolute left-6 top-6 z-10 rounded bg-[var(--color-surface)]/10 px-3 py-1 text-sm text-[var(--color-primary-foreground)]">
        {idx + 1} / {ordered.length} · {frame.name}
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`, transformOrigin: '0 0' }}
        >
          {/* 框架边框 */}
          <div
            className="absolute rounded-lg border-4"
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
              borderColor: frame.color ?? '#c7d2fe',
              background: 'rgba(255,255,255,0.97)'
            }}
          />
          {/* SVG 层：连线（含箭头标记）与手绘路径 */}
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
            {visibleConnectors.map((conn) => (
              <WhiteboardElementView
                key={conn.id}
                element={conn}
                allElements={whiteboard.elements}
                selected={false}
                scale={scale}
                editing={false}
                onSelect={() => {}}
                onChange={() => {}}
                onStartEdit={() => {}}
                onEndEdit={() => {}}
                onDelete={() => {}}
                onStartConnect={() => {}}
                pendingConnectFrom={null}
                onFinishConnect={() => {}}
              />
            ))}
            {visibleFreehands.map((f) => (
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
          {/* 框内矩形元素（仅渲染，只读：editing=false，不交互） */}
          {visibleRects.map((el) => (
            <WhiteboardElementView
              key={el.id}
              element={el}
              allElements={whiteboard.elements}
              selected={false}
              scale={scale}
              editing={false}
              onSelect={() => {}}
              onChange={() => {}}
              onStartEdit={() => {}}
              onEndEdit={() => {}}
              onDelete={() => {}}
              onStartConnect={() => {}}
              pendingConnectFrom={null}
              onFinishConnect={() => {}}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-center gap-4 py-4">
        <button
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          disabled={idx === 0}
          className="rounded-full bg-[var(--color-surface)]/10 p-2 text-[var(--color-primary-foreground)] hover:bg-[var(--color-surface)]/20 disabled:opacity-30"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="text-[var(--color-primary-foreground)]/70 text-sm">方向键 / 空格翻页</span>
        <button
          onClick={() => setIdx((i) => Math.min(i + 1, ordered.length - 1))}
          disabled={idx === ordered.length - 1}
          className="rounded-full bg-[var(--color-surface)]/10 p-2 text-[var(--color-primary-foreground)] hover:bg-[var(--color-surface)]/20 disabled:opacity-30"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
