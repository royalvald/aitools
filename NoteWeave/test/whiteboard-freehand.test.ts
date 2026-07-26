import { describe, it, expect } from 'vitest'

// 这些函数定义在 WhiteboardCanvas.tsx 内部（非导出），为可测复制等价实现并验证逻辑。
// 与组件内实现保持一致；若组件内实现变更，需同步更新此处。

function pointsToPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} L ${points[0].x} ${points[0].y}`
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x} ${points[i].y}`
  }
  return d
}

function freehandHitTest(points: { x: number; y: number }[], world: { x: number; y: number }, tol: number): boolean {
  for (const p of points) {
    if (Math.hypot(p.x - world.x, p.y - world.y) <= tol) return true
  }
  return false
}

describe('whiteboard freehand helpers', () => {
  it('pointsToPath 空 → 空', () => {
    expect(pointsToPath([])).toBe('')
  })
  it('pointsToPath 单点 → M+L', () => {
    expect(pointsToPath([{ x: 1, y: 2 }])).toBe('M 1 2 L 1 2')
  })
  it('pointsToPath 多点 → M+L 序列', () => {
    const d = pointsToPath([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }])
    expect(d).toBe('M 0 0 L 10 5 L 20 0')
  })
  it('freehandHitTest 容差内命中', () => {
    expect(freehandHitTest([{ x: 10, y: 10 }], { x: 12, y: 10 }, 3)).toBe(true)
  })
  it('freehandHitTest 容差外不命中', () => {
    expect(freehandHitTest([{ x: 10, y: 10 }], { x: 20, y: 10 }, 3)).toBe(false)
  })
  it('freehandHitTest 多点只要一点命中即 true', () => {
    expect(freehandHitTest([{ x: 0, y: 0 }, { x: 50, y: 50 }], { x: 51, y: 50 }, 3)).toBe(true)
  })
})
