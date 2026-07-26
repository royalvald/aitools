import type { KbDocAnnotation } from '../types'

/**
 * 批注选区与原文偏移映射的纯函数集合。
 *
 * 第一版策略：仅允许「同一文本节点内的连续纯文本」选中。
 * 跨段落 / 跨块级元素 / 含 Markdown 符号 的选区判定为无效，
 * 通过限制选区范围规避「渲染文本 → 原文偏移」的复杂映射。
 */

export type AnnotationStatus = 'valid' | 'relocated' | 'invalid'

/** 捕获到的选区信息：文本 + 鼠标位置（用于定位右键菜单） */
export interface CapturedSelection {
  text: string
  position: { x: number; y: number }
}

/**
 * 判定当前 DOM 选区是否可作为批注来源。
 * 规则：必须有选区、起止在同一文本节点、为纯文本（同一 text node 即不含跨节点符号）、非空。
 */
export function isValidSelection(selection: Selection | null): { valid: boolean; reason?: string } {
  if (!selection) return { valid: false, reason: '无可用的选区' }
  if (selection.isCollapsed) return { valid: false, reason: '请先选中要批注的文字' }

  const { anchorNode, focusNode } = selection
  // 起止必须在同一个文本节点内（同一 DOM 段落/块级元素的纯文本片段）
  if (anchorNode !== focusNode || anchorNode?.nodeType !== Node.TEXT_NODE) {
    return { valid: false, reason: '请在同一段落内选择纯文本' }
  }

  const text = selection.toString()
  if (text.trim().length === 0) {
    return { valid: false, reason: '选中的内容为空' }
  }

  return { valid: true }
}

/** 捕获选区文本与触发位置，调用前应已通过 isValidSelection 校验。 */
export function captureSelection(selection: Selection | null, position: { x: number; y: number }): CapturedSelection | null {
  if (!selection) return null
  const text = selection.toString()
  if (!text) return null
  return { text, position }
}

/**
 * 将选中文本映射到 doc.content 的字符偏移。
 * - 唯一匹配：直接返回该位置
 * - 多个匹配：返回第一个匹配位置（第一版简化策略）
 * - 无匹配：返回 null
 */
export function resolveOffsets(text: string, content: string): { start: number; end: number } | null {
  if (!text) return null
  const start = content.indexOf(text)
  if (start === -1) return null
  return { start, end: start + text.length }
}

/**
 * 判定批注在当前内容下的状态（决定高亮渲染与面板标注）：
 * - valid：原偏移仍与 text 完全匹配，按原偏移高亮
 * - relocated：原偏移不符，但 text 仍能在内容中搜到，按首个匹配重新高亮
 * - invalid：text 也搜不到，原文已被改写，不高亮
 *
 * 返回 relocated / invalid 时附带重新解析到的偏移，供高亮渲染使用。
 */
export function getAnnotationStatus(
  annotation: Pick<KbDocAnnotation, 'text' | 'startOffset' | 'endOffset'>,
  content: string
): { status: AnnotationStatus; start?: number; end?: number } {
  const { text, startOffset, endOffset } = annotation
  if (content.slice(startOffset, endOffset) === text) {
    return { status: 'valid', start: startOffset, end: endOffset }
  }
  const resolved = resolveOffsets(text, content)
  if (resolved) {
    return { status: 'relocated', start: resolved.start, end: resolved.end }
  }
  return { status: 'invalid' }
}

/**
 * 判断新选区是否与已存在的某条批注范围完全相同（用于「再次选中已批注文本 → 进入编辑」）。
 */
export function findExactOverlap(
  annotations: KbDocAnnotation[],
  start: number,
  end: number
): KbDocAnnotation | undefined {
  return annotations.find((a) => a.startOffset === start && a.endOffset === end)
}
