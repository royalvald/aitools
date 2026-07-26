import type { Plugin, Transformer } from 'unified'
import type { Root, RootContent } from 'mdast'

/**
 * REQ-104 脚注：把 `[^id]` 行内引用与 `[^id]: 内容` 底部定义重写为可点击的 HTML 锚点。
 *
 * - 引用 `[^id]` → `<sup><a href="#fn-id" data-footnote-ref="id">[n]</a></sup>`
 *   （n 为出现顺序的编号）
 * - 定义 `[^id]: 内容` → `<div id="fn-id" class="footnote-def"><sup>id</sup> 内容</div>`
 *
 * 这样在 react-markdown 预览端、Milkdown 编辑端、导出端，点击引用都能通过
 * 浏览器原生锚点跳转滚动到对应定义，满足「点击引用自动滚动到脚注」验收项。
 *
 * 注意：在已启用 remark-footnotes 的预览端，footnotes 已被原生解析，
 * 本插件作为兜底（仅在仍有未解析的 `[^id]` 文本时生效）。
 */

let footnoteCounter = 0

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function remarkFootnoteLinksPlugin(): Plugin<[], Root> {
  const transformer: Transformer<Root> = (tree: Root): Root => {
    footnoteCounter = 0
    // 第一遍：收集所有 [^id]: 定义（行级，位于段落开头）
    // 第二遍：把 [^id] 引用替换为编号上标链接
    const idToNumber = new Map<string, number>()

    const visit = (nodes: RootContent[]): RootContent[] => {
      const out: RootContent[] = []
      for (const node of nodes) {
        const parent = node as unknown as { children?: RootContent[] }
        if (Array.isArray(parent.children)) {
          parent.children = visit(parent.children)
        }
        if (node.type === 'text' && 'value' in node) {
          out.push(...rewriteText(String(node.value), idToNumber))
        } else {
          out.push(node)
        }
      }
      return out
    }

    tree.children = visit(tree.children)
    return tree
  }
  return (() => transformer) as unknown as Plugin<[], Root>
}

function rewriteText(text: string, idToNumber: Map<string, number>): RootContent[] {
  const result: RootContent[] = []
  // 同时匹配引用 [^id] 与定义 [^id]: 内容
  const re = /\[\^([^\]\s]+)\](?::\s*([^\n]*))?/g
  let last = 0
  let m: RegExpExecArray | null
  let matched = false
  while ((m = re.exec(text)) !== null) {
    matched = true
    const id = m[1]
    const defContent = m[2]
    if (m.index > last) {
      result.push({ type: 'text', value: text.slice(last, m.index) } as RootContent)
    }
    if (defContent !== undefined && defContent !== '') {
      // 定义：输出带 id 的 div
      const html = `<div id="fn-${esc(id)}" class="footnote-def"><sup>[${esc(id)}]</sup> ${esc(defContent.trim())}</div>`
      result.push({ type: 'html', value: html } as RootContent)
    } else {
      // 引用：分配编号
      if (!idToNumber.has(id)) {
        footnoteCounter += 1
        idToNumber.set(id, footnoteCounter)
      }
      const num = idToNumber.get(id)!
      const html = `<sup><a href="#fn-${esc(id)}" data-footnote-ref="${esc(id)}">[${num}]</a></sup>`
      result.push({ type: 'html', value: html } as RootContent)
    }
    last = m.index + m[0].length
  }
  if (!matched) {
    return [{ type: 'text', value: text } as RootContent]
  }
  if (last < text.length) {
    result.push({ type: 'text', value: text.slice(last) } as RootContent)
  }
  return result
}
