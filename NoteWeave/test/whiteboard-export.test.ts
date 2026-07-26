import { describe, it, expect } from 'vitest'
import { whiteboardBounds, whiteboardToSvg, whiteboardToMarkdown } from '../src/shared/whiteboard-export'
import type { Whiteboard, WhiteboardStickyNote, WhiteboardFreehand } from '../src/shared/types'

function makeWb(overrides: Partial<Whiteboard> = {}): Whiteboard {
  return {
    kbId: 'kb1',
    docId: 'doc1',
    elements: [],
    frames: [],
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    background: 'dot',
    createdAt: '',
    updatedAt: '',
    ...overrides
  }
}

function sticky(x: number, y: number, text: string): WhiteboardStickyNote {
  return {
    id: 's' + x,
    type: 'sticky',
    x,
    y,
    width: 100,
    height: 60,
    zIndex: 1,
    text,
    color: '#fef9c3',
    createdAt: '',
    updatedAt: ''
  }
}

describe('whiteboard-export bounds', () => {
  it('空白板返回默认尺寸', () => {
    const b = whiteboardBounds(makeWb())
    expect(b.width).toBe(1000)
    expect(b.height).toBe(700)
  })
  it('含便签时包围盒为便签范围', () => {
    const wb = makeWb({ elements: [sticky(100, 100, 'a'), sticky(400, 300, 'b')] })
    const b = whiteboardBounds(wb)
    expect(b.minX).toBe(100)
    expect(b.minY).toBe(100)
    expect(b.width).toBe(400) // 500-100
    expect(b.height).toBe(260) // 360-100
  })
  it('freehand 点纳入包围盒', () => {
    const f: WhiteboardFreehand = {
      id: 'f1',
      type: 'freehand',
      points: [{ x: 10, y: 20 }, { x: 30, y: 5 }],
      color: '#000',
      strokeWidth: 2,
      style: 'smooth',
      zIndex: 0,
      createdAt: '',
      updatedAt: ''
    }
    const b = whiteboardBounds(makeWb({ elements: [f] }))
    expect(b.minX).toBe(10)
    expect(b.minY).toBe(5)
  })
})

describe('whiteboard-export svg', () => {
  it('生成合法 SVG 含便签', () => {
    const wb = makeWb({ elements: [sticky(100, 100, '你好')] })
    const svg = whiteboardToSvg(wb)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<rect')
    expect(svg).toContain('你好')
    expect(svg.endsWith('</svg>')).toBe(true)
  })
  it('SVG 转义特殊字符', () => {
    const wb = makeWb({ elements: [sticky(0, 0, 'a<b>"c')] })
    expect(whiteboardToSvg(wb)).toContain('&lt;')
    expect(whiteboardToSvg(wb)).toContain('&quot;')
  })
  it('框架可选包含', () => {
    const wb = makeWb({ frames: [{ id: 'fr', name: '框架', x: 0, y: 0, width: 100, height: 100, order: 1 }] })
    expect(whiteboardToSvg(wb, true)).toContain('框架')
  })
})

describe('whiteboard-export markdown', () => {
  it('便签按 y→x 排序转为列表', () => {
    const wb = makeWb({
      elements: [sticky(200, 100, '第二'), sticky(100, 50, '第一'), sticky(100, 200, '第三')]
    })
    const md = whiteboardToMarkdown(wb)
    expect(md).toContain('# 白板便签大纲')
    const firstIdx = md.indexOf('第一')
    const secondIdx = md.indexOf('第二')
    const thirdIdx = md.indexOf('第三')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })
  it('无便签时标注空', () => {
    expect(whiteboardToMarkdown(makeWb())).toContain('（无便签）')
  })
})
