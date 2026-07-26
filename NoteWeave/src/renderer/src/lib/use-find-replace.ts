import { useCallback, useMemo } from 'react'
import type { FindReplaceController } from '../components/FindReplaceBar'

// REQ-101：为源码/即时模式（textarea）构造查找替换控制器。
//
// 工作方式：MDEditor 渲染一个 <textarea>，我们通过 closest 容器内的查询拿到它，
// 直接用 selectionStart/End / setSelectionRange / scrollIntoView 实现定位与替换。
// 通过 onChange 回写新全文。

interface UseTextControllerOptions {
  value: string
  onChange: (next: string) => void
  /** 查找 textarea 的容器元素引用（编辑器外层 div）。 */
  containerRef: React.RefObject<HTMLElement | null>
}

export function useTextFindReplaceController({
  value,
  onChange,
  containerRef
}: UseTextControllerOptions): FindReplaceController {
  const getTa = useCallback((): HTMLTextAreaElement | null => {
    const root = containerRef.current ?? document
    return (root.querySelector('textarea') as HTMLTextAreaElement | null) ?? null
  }, [containerRef])

  const selectRange = useCallback(
    (start: number, end: number) => {
      const ta = getTa()
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(start, end)
      // 滚动到可视区
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20
      const lines = ta.value.slice(0, start).split('\n').length
      ta.scrollTop = Math.max(0, lines * lineHeight - ta.clientHeight / 2)
    },
    [getTa]
  )

  const replaceSingle = useCallback(
    (start: number, end: number, replacement: string) => {
      const next = value.slice(0, start) + replacement + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        const ta = getTa()
        if (!ta) return
        ta.focus()
        const pos = start + replacement.length
        ta.setSelectionRange(pos, pos)
      })
    },
    [value, onChange, getTa]
  )

  const replaceAllContent = useCallback(
    (newText: string) => {
      onChange(newText)
    },
    [onChange]
  )

  return useMemo(
    () => ({
      selectRange,
      replaceSingle,
      replaceAllContent,
      getFullText: () => value
    }),
    [value, selectRange, replaceSingle, replaceAllContent]
  )
}

// Milkdown（WYSIWYG）查找替换控制器：基于全文 markdown 源码做匹配，
// 但定位/替换作用于编辑器内部。
//
// 已知近似：ProseMirror 文档纯文本（doc.textContent）与 markdown 源码偏移不一致
//（markdown 语法符号、链接 URL 等不进入纯文本）。因此这里把「markdown 偏移区间」
// 换算为「待匹配文本 + 它在全文中第几次出现（0 起）」交给编辑器定位：
// 编辑器在 doc.textContent 中枚举所有出现位置并取第 N 个，重复文本能正确定位到第 N 处。

export interface MilkdownControllerOptions {
  value: string
  onChange: (next: string) => void
  /** MilkdownEditor 暴露的命令接口。 */
  editorApi: {
    selectTextOccurrence?: (text: string, occurrence: number) => void
    replaceTextOccurrence?: (text: string, occurrence: number, replacement: string) => void
  } | null
}

/** 由 markdown 偏移区间换算「文本 + 第几次出现（0 起）」。 */
function toOccurrence(value: string, start: number, end: number): { text: string; occurrence: number } {
  const text = value.slice(start, end)
  let occurrence = 0
  let i = -1
  const before = value.slice(0, start)
  while (text && (i = before.indexOf(text, i + 1)) !== -1) occurrence += 1
  return { text, occurrence }
}

export function useMilkdownFindReplaceController({
  value,
  onChange,
  editorApi
}: MilkdownControllerOptions): FindReplaceController {
  const selectRange = useCallback(
    (start: number, end: number) => {
      const { text, occurrence } = toOccurrence(value, start, end)
      editorApi?.selectTextOccurrence?.(text, occurrence)
    },
    [editorApi, value]
  )
  const replaceSingle = useCallback(
    (start: number, end: number, replacement: string) => {
      // 优先用编辑器命令原地替换；否则回退到全文覆盖
      if (editorApi?.replaceTextOccurrence) {
        const { text, occurrence } = toOccurrence(value, start, end)
        editorApi.replaceTextOccurrence(text, occurrence, replacement)
      } else {
        const next = value.slice(0, start) + replacement + value.slice(end)
        onChange(next)
      }
    },
    [editorApi, value, onChange]
  )
  return useMemo(
    () => ({
      selectRange,
      replaceSingle,
      replaceAllContent: onChange,
      getFullText: () => value
    }),
    [value, selectRange, replaceSingle, onChange]
  )
}
