import { describe, it, expect } from 'vitest'
import {
  clampScale,
  screenToWorld,
  worldToScreen,
  hitTest,
  pickElement,
  boxSelect,
  anchorPoint,
  connectorEndpoints,
  connectorPath,
  nextZIndex,
  resizeRect,
  resizeHandlePos,
  pointsToPath,
  freehandBounds,
  rectsIntersect
} from '../src/renderer/src/lib/whiteboard-canvas'
import type {
  WhiteboardElement,
  WhiteboardStickyNote,
  WhiteboardShape,
  WhiteboardConnector,
  WhiteboardFreehand
} from '../src/shared/types'

function makeSticky(overrides: Partial<WhiteboardStickyNote> = {}): WhiteboardStickyNote {
  return {
    id: 's1',
    type: 'sticky',
    x: 100,
    y: 100,
    width: 160,
    height: 120,
    zIndex: 1,
    text: 'hi',
    color: '#fef9c3',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function makeConnector(fromId: string, toId: string): WhiteboardConnector {
  return {
    id: 'c1',
    type: 'connector',
    from: { elementId: fromId, anchor: 'right' },
    to: { elementId: toId, anchor: 'left' },
    path: 'straight',
    arrowEnd: true,
    zIndex: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('whiteboard-canvas transform', () => {
  it('clampScale 限制在 0.1~4', () => {
    expect(clampScale(0.05)).toBe(0.1)
    expect(clampScale(5)).toBe(4)
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('screenToWorld / worldToScreen 互逆', () => {
    const w = screenToWorld(150, 250, 2, 10, 20)
    expect(w).toEqual({ x: 70, y: 115 })
    const s = worldToScreen(70, 115, 2, 10, 20)
    expect(s).toEqual({ x: 150, y: 250 })
  })

  it('hitTest 命中元素内部', () => {
    const el = makeSticky()
    expect(hitTest(el, 120, 150)).toBe(true)
    expect(hitTest(el, 50, 50)).toBe(false)
  })

  it('hitTest 忽略 connector', () => {
    const conn = makeConnector('a', 'b')
    expect(hitTest(conn as unknown as WhiteboardElement, 0, 0)).toBe(false)
  })

  it('pickElement 返回最上层命中元素', () => {
    const lower = makeSticky({ id: 'lower', zIndex: 1 })
    const upper = makeSticky({ id: 'upper', zIndex: 5 })
    const picked = pickElement([lower, upper], 150, 150)
    expect(picked?.id).toBe('upper')
  })

  it('boxSelect 返回完全包含的元素', () => {
    const a = makeSticky({ id: 'a', x: 10, y: 10 })
    const b = makeSticky({ id: 'b', x: 500, y: 500 })
    const ids = boxSelect([a, b], 0, 0, 300, 300)
    expect(ids).toEqual(['a'])
  })
})

describe('whiteboard-canvas connector geometry', () => {
  it('anchorPoint 计算四边中点', () => {
    const el = makeSticky({ width: 100, height: 60 })
    expect(anchorPoint(el, 'top')).toEqual({ x: 150, y: 100 })
    expect(anchorPoint(el, 'right')).toEqual({ x: 200, y: 130 })
    expect(anchorPoint(el, 'bottom')).toEqual({ x: 150, y: 160 })
    expect(anchorPoint(el, 'left')).toEqual({ x: 100, y: 130 })
  })

  it('connectorEndpoints 根据元素锚点计算起止', () => {
    const a = makeSticky({ id: 'a', x: 0, y: 0, width: 100, height: 100 })
    const b = makeSticky({ id: 'b', x: 300, y: 0, width: 100, height: 100 })
    const conn = makeConnector('a', 'b')
    const { from, to } = connectorEndpoints(conn, [a, b])
    expect(from).toEqual({ x: 100, y: 50 }) // a right
    expect(to).toEqual({ x: 300, y: 50 }) // b left
  })

  it('connectorEndpoints 元素缺失回退 (0,0)', () => {
    const conn = makeConnector('a', 'b')
    const { from, to } = connectorEndpoints(conn, [])
    expect(from).toEqual({ x: 0, y: 0 })
    expect(to).toEqual({ x: 0, y: 0 })
  })

  it('connectorPath straight/orthogonal/bezier', () => {
    const conn = makeConnector('a', 'b')
    expect(connectorPath(conn, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe('M 0 0 L 100 0')
    conn.path = 'orthogonal'
    expect(connectorPath(conn, { x: 0, y: 0 }, { x: 100, y: 50 })).toContain('L')
    conn.path = 'bezier'
    expect(connectorPath(conn, { x: 0, y: 0 }, { x: 100, y: 0 })).toContain('C')
  })

  it('nextZIndex 返回最大值+1', () => {
    const els = [makeSticky({ zIndex: 3 }), makeSticky({ id: 's2', zIndex: 7 })]
    expect(nextZIndex(els)).toBe(8)
    expect(nextZIndex([])).toBe(1)
  })
})

describe('resizeRect（8 点缩放 + Shift 等比）', () => {
  const origin = { x: 100, y: 100, width: 200, height: 100 }

  it('右下角拖拽：仅改宽高，锚定左上角', () => {
    expect(resizeRect(origin, 'bottom-right', 20, 10)).toEqual({ x: 100, y: 100, width: 220, height: 110 })
  })

  it('左边中点拖拽：改 x 与宽，锚定右边', () => {
    expect(resizeRect(origin, 'left', 30, 999)).toEqual({ x: 130, y: 100, width: 170, height: 100 })
  })

  it('左上角拖拽：同时改 x/y/宽/高', () => {
    expect(resizeRect(origin, 'top-left', 10, 10)).toEqual({ x: 110, y: 110, width: 190, height: 90 })
  })

  it('最小尺寸保护：不小于 minSize 且锚定对侧', () => {
    expect(resizeRect(origin, 'right', -500, 0, false, 20)).toEqual({ x: 100, y: 100, width: 20, height: 100 })
    expect(resizeRect(origin, 'left', 500, 0, false, 20)).toEqual({ x: 280, y: 100, width: 20, height: 100 })
  })

  it('Shift 等比：角点拖拽保持宽高比', () => {
    const r = resizeRect(origin, 'bottom-right', 100, 10, true)
    expect(r.width / r.height).toBeCloseTo(2, 5)
  })

  it('Shift 等比：边中点拖拽另一维围绕中心联动', () => {
    const r = resizeRect(origin, 'right', 100, 0, true)
    expect(r).toEqual({ x: 100, y: 75, width: 300, height: 150 })
  })
})

describe('resizeHandlePos', () => {
  it('角点与边中点定位', () => {
    const rect = { width: 200, height: 100 }
    expect(resizeHandlePos(rect, 'top-left')).toEqual({ x: 0, y: 0 })
    expect(resizeHandlePos(rect, 'bottom-right')).toEqual({ x: 200, y: 100 })
    expect(resizeHandlePos(rect, 'top')).toEqual({ x: 100, y: 0 })
    expect(resizeHandlePos(rect, 'left')).toEqual({ x: 0, y: 50 })
  })
})

describe('pointsToPath / freehandBounds / rectsIntersect（演示模式修复）', () => {
  const freehand = {
    id: 'f1',
    type: 'freehand',
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 60 },
      { x: 60, y: 220 }
    ],
    color: '#000',
    strokeWidth: 3,
    zIndex: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  } as WhiteboardFreehand

  it('pointsToPath 序列化为折线 path', () => {
    expect(pointsToPath(freehand.points)).toBe('M 10 20 L 110 60 L 60 220')
    expect(pointsToPath([])).toBe('')
  })

  it('freehandBounds 计算 points 包围盒', () => {
    expect(freehandBounds(freehand)).toEqual({ x: 10, y: 20, width: 100, height: 200 })
  })

  it('rectsIntersect 相交判定', () => {
    const frame = { x: 0, y: 0, width: 100, height: 100 }
    expect(rectsIntersect({ x: 50, y: 50, width: 100, height: 100 }, frame)).toBe(true)
    expect(rectsIntersect({ x: 200, y: 0, width: 50, height: 50 }, frame)).toBe(false)
  })
})
