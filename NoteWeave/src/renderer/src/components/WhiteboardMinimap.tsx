import { useMemo, useRef } from 'react'
import { whiteboardBounds } from '../../../shared/whiteboard-export'
import type { BaseWhiteboardElement, Whiteboard, WhiteboardFreehand } from '../types'

interface WhiteboardMinimapProps {
  whiteboard: Whiteboard
  viewportWidth: number
  viewportHeight: number
  onPan: (worldX: number, worldY: number) => void
}

const MAP_WIDTH = 180
const MAP_HEIGHT = 120
const PADDING = 16

export function WhiteboardMinimap({
  whiteboard,
  viewportWidth,
  viewportHeight,
  onPan
}: WhiteboardMinimapProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const bounds = useMemo(() => {
    const b = whiteboardBounds(whiteboard)
    // 扩展边界，给画布留白
    return {
      minX: b.minX - PADDING,
      minY: b.minY - PADDING,
      width: b.width + PADDING * 2,
      height: b.height + PADDING * 2
    }
  }, [whiteboard])

  const scale = useMemo(() => {
    return Math.min(MAP_WIDTH / bounds.width, MAP_HEIGHT / bounds.height)
  }, [bounds])

  const mapW = bounds.width * scale
  const mapH = bounds.height * scale
  const offsetX = (MAP_WIDTH - mapW) / 2
  const offsetY = (MAP_HEIGHT - mapH) / 2

  const toMapX = (x: number) => offsetX + (x - bounds.minX) * scale
  const toMapY = (y: number) => offsetY + (y - bounds.minY) * scale

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const wx = bounds.minX + (mx - offsetX) / scale
    const wy = bounds.minY + (my - offsetY) / scale
    onPan(wx, wy)
  }

  const viewportRect = {
    x: toMapX(-(whiteboard.offsetX ?? 0) / whiteboard.scale),
    y: toMapY(-(whiteboard.offsetY ?? 0) / whiteboard.scale),
    width: (viewportWidth / whiteboard.scale) * scale,
    height: (viewportHeight / whiteboard.scale) * scale
  }

  return (
    <div className="surface-elevated pointer-events-auto overflow-hidden" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
      <svg
        ref={svgRef}
        width={MAP_WIDTH}
        height={MAP_HEIGHT}
        className="cursor-pointer"
        onClick={handleClick}
      >
        {/* 背景 */}
        <rect x={0} y={0} width={MAP_WIDTH} height={MAP_HEIGHT} fill="var(--color-surface-2)" />

        {/* 元素缩略 */}
        {whiteboard.elements.map((el) => {
          if (el.type === 'connector') return null
          if (el.type === 'freehand') {
            const f = el as WhiteboardFreehand
            const pts = (f.points ?? [])
              .map((p) => `${toMapX(p.x)},${toMapY(p.y)}`)
              .join(' ')
            if (!pts) return null
            return (
              <polyline
                key={el.id}
                points={pts}
                fill="none"
                stroke="var(--color-muted-foreground)"
                strokeWidth={1}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.5}
              />
            )
          }
          const b = el as BaseWhiteboardElement & { color?: string; fill?: string }
          const fill =
            el.type === 'sticky'
              ? b.color ?? '#fde047'
              : el.type === 'content'
                ? 'var(--color-accent-soft)'
                : b.fill ?? 'var(--color-surface)'
          return (
            <rect
              key={el.id}
              x={toMapX(b.x)}
              y={toMapY(b.y)}
              width={Math.max(2, b.width * scale)}
              height={Math.max(2, b.height * scale)}
              rx={el.type === 'shape' && (b as { shape?: string }).shape === 'circle' ? Math.max(2, b.width * scale / 2) : 2}
              fill={fill}
              stroke="var(--color-border-strong)"
              strokeWidth={0.5}
              opacity={0.85}
            />
          )
        })}

        {/* 框架 */}
        {(whiteboard.frames ?? []).map((f) => (
          <rect
            key={`frame-${f.id}`}
            x={toMapX(f.x)}
            y={toMapY(f.y)}
            width={Math.max(2, f.width * scale)}
            height={Math.max(2, f.height * scale)}
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth={1}
            strokeDasharray="2 2"
            opacity={0.6}
          />
        ))}

        {/* 当前视口 */}
        <rect
          x={viewportRect.x}
          y={viewportRect.y}
          width={Math.max(4, viewportRect.width)}
          height={Math.max(4, viewportRect.height)}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={1.5}
          rx={2}
        />
      </svg>
    </div>
  )
}
