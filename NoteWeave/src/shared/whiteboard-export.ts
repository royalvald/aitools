import type { Whiteboard, WhiteboardElement, BaseWhiteboardElement, WhiteboardFreehand } from './types'

// REQ-228 白板导出纯函数：序列化为 SVG / Markdown 大纲（无 DOM/Electron 依赖，便于单测）。

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 计算所有元素的包围盒（含 freehand 点），用于 SVG viewBox 与导出范围
export function whiteboardBounds(wb: Whiteboard): { minX: number; minY: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const el of wb.elements) {
    if (el.type === 'freehand') {
      for (const p of (el as WhiteboardFreehand).points ?? []) consider(p.x, p.y)
    } else if (el.type !== 'connector') {
      const b = el as BaseWhiteboardElement
      consider(b.x, b.y)
      consider(b.x + b.width, b.y + b.height)
    }
  }
  for (const f of wb.frames ?? []) {
    consider(f.x, f.y)
    consider(f.x + f.width, f.y + f.height)
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, width: 1000, height: 700 }
  }
  return { minX, minY, width: maxX - minX || 1000, height: maxY - minY || 700 }
}

// 单元素 → SVG 片段
function elementToSvg(el: WhiteboardElement): string {
  if (el.type === 'freehand') {
    const f = el as WhiteboardFreehand
    const pts = (f.points ?? []).map((p) => `${p.x},${p.y}`).join(' ')
    return `<polyline points="${pts}" fill="none" stroke="${f.color}" stroke-width="${f.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
  }
  if (el.type === 'connector') return '' // 连线导出复杂，省略
  const b = el as BaseWhiteboardElement & { color?: string; fill?: string; stroke?: string; strokeWidth?: number; shape?: string; text?: string; fontSize?: number }
  if (el.type === 'sticky') {
    let s = `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="4" fill="${b.color ?? '#fef9c3'}" stroke="#e2e8f0"/>`
    if (b.text) s += textSvg(b.x + 8, b.y + 20, b.text, 14)
    return s
  }
  if (el.type === 'shape') {
    const kind = b.shape ?? 'rect'
    let s = `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${kind === 'rounded-rect' ? 12 : 0}" fill="${b.fill ?? '#fff'}" stroke="${b.stroke ?? '#475569'}" stroke-width="${b.strokeWidth ?? 2}"/>`
    if (b.text) s += textSvg(b.x + b.width / 2, b.y + b.height / 2, b.text, 14, 'middle')
    return s
  }
  if (el.type === 'text') {
    return textSvg(b.x, b.y + (b.fontSize ?? 16), b.text ?? '', b.fontSize ?? 16)
  }
  if (el.type === 'content') {
    let s = `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="6" fill="#fff" stroke="#cbd5e1"/>`
    s += textSvg(b.x + 8, b.y + 18, (b as { title?: string }).title ?? '', 13)
    return s
  }
  return ''
}

function textSvg(x: number, y: number, text: string, size: number, anchor: 'start' | 'middle' = 'start'): string {
  const safe = escapeXml(text ?? '')
  // 多行拆为 tspan
  const lines = safe.split('\n').slice(0, 8)
  const tspans = lines.map((ln, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : size + 2}">${ln.slice(0, 60)}</tspan>`).join('')
  return `<text font-size="${size}" fill="#1e293b" text-anchor="${anchor}">${tspans}</text>`
}

// 整个白板 → SVG 字符串（含框架）
export function whiteboardToSvg(wb: Whiteboard, includeFrames = true): string {
  const b = whiteboardBounds(wb)
  const pad = 24
  const parts: string[] = []
  // 框架
  if (includeFrames) {
    for (const f of wb.frames ?? []) {
      parts.push(`<rect x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" rx="8" fill="${(f.color ?? '#c7d2fe') + '15'}" stroke="${f.color ?? '#6366f1'}" stroke-width="2"/>`)
      parts.push(textSvg(f.x + 8, f.y - 8, `${f.name}`, 13))
    }
  }
  // 元素（按 zIndex 排序，freehand 在最底）
  const sorted = [...wb.elements].sort((a, c) => (a.zIndex ?? 0) - (c.zIndex ?? 0))
  for (const el of sorted) {
    parts.push(elementToSvg(el))
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${b.width + pad * 2}" height="${b.height + pad * 2}" viewBox="${b.minX - pad} ${b.minY - pad} ${b.width + pad * 2} ${b.height + pad * 2}"><rect x="${b.minX - pad}" y="${b.minY - pad}" width="${b.width + pad * 2}" height="${b.height + pad * 2}" fill="#ffffff"/>${parts.join('')}</svg>`
}

// 白板 → Markdown 大纲：便签按 y→x 顺序转为列表项
export function whiteboardToMarkdown(wb: Whiteboard): string {
  const stickies = wb.elements
    .filter((el) => el.type === 'sticky')
    .map((el) => el as BaseWhiteboardElement & { text: string })
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
  const lines: string[] = ['# 白板便签大纲']
  if (stickies.length === 0) {
    lines.push('', '（无便签）')
    return lines.join('\n')
  }
  lines.push('')
  for (const s of stickies) {
    const text = (s.text || '').trim()
    const first = text.split('\n')[0].slice(0, 60) || '（空便签）'
    lines.push(`- ${first}`)
  }
  return lines.join('\n')
}
