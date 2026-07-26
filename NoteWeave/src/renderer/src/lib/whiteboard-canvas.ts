import type {
  AnchorName,
  BaseWhiteboardElement,
  WhiteboardElement,
  WhiteboardConnector,
  WhiteboardFreehand
} from '../types'

// REQ-221 画布坐标变换与命中检测纯函数。

// 缩放手柄锚点：4 边中点 + 4 角（连线锚点仅 4 边中点，见 AnchorName）
export type ResizeAnchor = AnchorName | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const RESIZE_ANCHORS: ResizeAnchor[] = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left'
]

export const RESIZE_CURSORS: Record<ResizeAnchor, string> = {
  'top-left': 'nwse-resize',
  top: 'ns-resize',
  'top-right': 'nesw-resize',
  right: 'ew-resize',
  'bottom-right': 'nwse-resize',
  bottom: 'ns-resize',
  'bottom-left': 'nesw-resize',
  left: 'ew-resize'
}

// 缩放手柄在元素本地坐标系（相对元素左上角，世界像素）中的位置
export function resizeHandlePos(
  rect: { width: number; height: number },
  anchor: ResizeAnchor
): { x: number; y: number } {
  const x = anchor.includes('left') ? 0 : anchor.includes('right') ? rect.width : rect.width / 2
  const y = anchor.includes('top') ? 0 : anchor.includes('bottom') ? rect.height : rect.height / 2
  return { x, y }
}

export interface RectBounds {
  x: number
  y: number
  width: number
  height: number
}

// 按锚点拖拽缩放矩形：dx/dy 为世界坐标位移；keepRatio（Shift）保持原始宽高比；
// 最小尺寸 minSize，左/上锚点按最终尺寸反推位置（锚定对侧不动）。
export function resizeRect(
  origin: RectBounds,
  anchor: ResizeAnchor,
  dx: number,
  dy: number,
  keepRatio = false,
  minSize = 20
): RectBounds {
  let { x, y, width, height } = origin
  const h = anchor.includes('left') ? 'left' : anchor.includes('right') ? 'right' : null
  const v = anchor.includes('top') ? 'top' : anchor.includes('bottom') ? 'bottom' : null
  if (h === 'left') {
    x = origin.x + dx
    width = origin.width - dx
  } else if (h === 'right') {
    width = origin.width + dx
  }
  if (v === 'top') {
    y = origin.y + dy
    height = origin.height - dy
  } else if (v === 'bottom') {
    height = origin.height + dy
  }
  if (keepRatio && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height
    if (h && v) {
      if (width / Math.max(height, 1) > ratio) width = height * ratio
      else height = width / ratio
    } else if (h) {
      // 仅水平边中点：高度围绕垂直中心联动
      height = width / ratio
      y = origin.y + origin.height / 2 - height / 2
    } else if (v) {
      width = height * ratio
      x = origin.x + origin.width / 2 - width / 2
    }
  }
  if (width < minSize) width = minSize
  if (height < minSize) height = minSize
  if (h === 'left') x = origin.x + origin.width - width
  if (v === 'top') y = origin.y + origin.height - height
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

// REQ-227 手绘路径点序列化为 SVG path d
export function pointsToPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`
  }
  return d
}

// 手绘路径的包围盒（世界坐标），用于框架包含判定 / 演示模式过滤
export function freehandBounds(f: WhiteboardFreehand): RectBounds {
  const pts = f.points ?? []
  if (pts.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

// 两个矩形是否相交（世界坐标）
export function rectsIntersect(a: RectBounds, b: RectBounds): boolean {
  return a.x + a.width > b.x && a.x < b.x + b.width && a.y + a.height > b.y && a.y < b.y + b.height
}

export const MIN_SCALE = 0.1
export const MAX_SCALE = 4

export function clampScale(s: number): number {
  return Math.min(Math.max(s, MIN_SCALE), MAX_SCALE)
}

// 屏幕坐标（相对画布视口左上角的像素）→ 画布世界坐标
export function screenToWorld(
  screenX: number,
  screenY: number,
  scale: number,
  offsetX: number,
  offsetY: number
): { x: number; y: number } {
  return {
    x: (screenX - offsetX) / scale,
    y: (screenY - offsetY) / scale
  }
}

// 世界坐标 → 屏幕坐标
export function worldToScreen(
  worldX: number,
  worldY: number,
  scale: number,
  offsetX: number,
  offsetY: number
): { x: number; y: number } {
  return {
    x: worldX * scale + offsetX,
    y: worldY * scale + offsetY
  }
}

// 元素是否命中某个世界坐标点（点是否在元素矩形内）
export function hitTest(el: WhiteboardElement, wx: number, wy: number): boolean {
  if (el.type === 'connector' || el.type === 'freehand') return false
  const base = el as BaseWhiteboardElement
  return wx >= base.x && wx <= base.x + base.width && wy >= base.y && wy <= base.y + base.height
}

// 在一组元素中找最上层命中的元素（zIndex 大的在上面）
export function pickElement(
  elements: WhiteboardElement[],
  wx: number,
  wy: number
): WhiteboardElement | null {
  // 过滤掉非矩形元素（connector/freehand 不参与框选点选）
  const sorted = [...elements]
    .filter((el) => el.type !== 'connector' && el.type !== 'freehand')
    .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
  for (const el of sorted) {
    if (hitTest(el, wx, wy)) return el
  }
  return null
}

// 框选：返回完全落在矩形内的元素 id 集合
export function boxSelect(
  elements: WhiteboardElement[],
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string[] {
  const left = Math.min(x1, x2)
  const right = Math.max(x1, x2)
  const top = Math.min(y1, y2)
  const bottom = Math.max(y1, y2)
  const ids: string[] = []
  for (const el of elements) {
    if (el.type === 'connector' || el.type === 'freehand') continue
    const base = el as BaseWhiteboardElement
    if (base.x >= left && base.x + base.width <= right && base.y >= top && base.y + base.height <= bottom) {
      ids.push(el.id)
    }
  }
  return ids
}

// 元素四个锚点在世界坐标中的位置（用于连线跟随）
export function anchorPoint(el: BaseWhiteboardElement, anchor: AnchorName): { x: number; y: number } {
  switch (anchor) {
    case 'top':
      return { x: el.x + el.width / 2, y: el.y }
    case 'right':
      return { x: el.x + el.width, y: el.y + el.height / 2 }
    case 'bottom':
      return { x: el.x + el.width / 2, y: el.y + el.height }
    case 'left':
      return { x: el.x, y: el.y + el.height / 2 }
  }
}

// REQ-222 连线路径点（世界坐标）。简化：直线/折线/贝塞尔的起止点。
export function connectorEndpoints(
  conn: WhiteboardConnector,
  elements: WhiteboardElement[]
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const fromEl = elements.find(
    (e) => e.id === conn.from.elementId && e.type !== 'connector' && e.type !== 'freehand'
  ) as BaseWhiteboardElement | undefined
  const toEl = elements.find(
    (e) => e.id === conn.to.elementId && e.type !== 'connector' && e.type !== 'freehand'
  ) as BaseWhiteboardElement | undefined
  // 找不到元素时回退到 (0,0)
  const from = fromEl ? anchorPoint(fromEl, conn.from.anchor) : { x: 0, y: 0 }
  const to = toEl ? anchorPoint(toEl, conn.to.anchor) : { x: 0, y: 0 }
  return { from, to }
}

// 根据 path 类型生成 SVG d 属性
export function connectorPath(
  conn: WhiteboardConnector,
  from: { x: number; y: number },
  to: { x: number; y: number }
): string {
  if (conn.path === 'straight') {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  }
  if (conn.path === 'orthogonal') {
    const midX = (from.x + to.x) / 2
    return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`
  }
  // bezier
  const c1x = from.x + (to.x - from.x) / 2
  const c2x = from.x + (to.x - from.x) / 2
  return `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`
}

// 下一个可用 zIndex
export function nextZIndex(elements: WhiteboardElement[]): number {
  return elements.reduce((max, e) => Math.max(max, e.zIndex ?? 0), 0) + 1
}
