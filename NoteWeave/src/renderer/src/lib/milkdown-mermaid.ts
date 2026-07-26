import { createRoot, type Root } from 'react-dom/client'
import React from 'react'
import { $remark, $nodeSchema, $view } from '@milkdown/utils'
import type { Ctx } from '@milkdown/ctx'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view'
import { MermaidDiagram } from '../components/MermaidDiagram'

/**
 * Milkdown WYSIWYG 编辑态 Mermaid 图表支持（REQ-003）。
 *
 * 预览端已通过 react-markdown 自定义 code 组件渲染 mermaid；本文件让 Milkdown 编辑端
 * 同样渲染 SVG，与预览一致。
 *
 * 实现路径：
 * - remark：自写 remark 插件，把 mdast 中 lang === 'mermaid' 的 code 节点改名为 mermaid
 *   （并保留 value），交给下面的 schema 解析。
 * - schema：定义 mermaid 块级 atom 节点，attrs.value 存图表源码；toMarkdown 还原为
 *   ```mermaid 代码块。
 * - view：原生 NodeView，内部用 ReactDOM.createRoot 渲染复用的 MermaidDiagram 组件；
 *   双击进入源码编辑（textarea），失焦 / Ctrl+Enter 写回 attrs。
 */

// remark 插件：把 code(lang=mermaid) 节点重命名为 mermaid，使下游 schema 能匹配。
// 采用 unified transformer 形式：遍历 mdast，原地修改节点 type。
const remarkMermaidPlugin = () => (tree: { children?: unknown[] }): void => {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; lang?: string; value?: unknown; children?: unknown[] }
    if (n.type === 'code' && n.lang === 'mermaid') {
      // 改名为 mermaid，保留 value（源码）与 lang 信息
      n.type = 'mermaid'
    }
    if (Array.isArray(n.children)) {
      n.children.forEach(visit)
    }
  }
  visit(tree)
}

export const remarkMermaid = $remark('remarkMermaid', () => remarkMermaidPlugin as never)

export const mermaidSchema = $nodeSchema('mermaid', () => ({
  group: 'block',
  atom: true,
  attrs: {
    value: { default: '' }
  },
  parseMarkdown: {
    match: (node) => node.type === 'mermaid',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'mermaid',
    runner: (state, node) => {
      // 还原为 markdown 代码块
      state.addNode('code', undefined, node.attrs.value, { lang: 'mermaid' })
    }
  }
}))

export const mermaidView = $view(mermaidSchema.node, () => {
  return (node: Node, view: EditorView, getPos: () => number | undefined) => {
    const wrapper = document.createElement('div')
    wrapper.classList.add('milkdown-mermaid-block')

    let reactRoot: Root | null = null
    const renderDiagram = (): void => {
      const value = (node.attrs.value as string) ?? ''
      if (!reactRoot) {
        reactRoot = createRoot(wrapper)
      }
      reactRoot.render(
        React.createElement(MermaidDiagram, { chart: value })
      )
    }

    const editSource = (): void => {
      const textarea = document.createElement('textarea')
      textarea.value = (node.attrs.value as string) ?? ''
      textarea.rows = 8
      textarea.className = 'milkdown-mermaid-input'
      const commit = (): void => {
        const pos = getPos()
        if (pos === undefined) return
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { value: textarea.value })
        view.dispatch(tr)
        view.focus()
      }
      textarea.addEventListener('blur', commit)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          commit()
        }
        e.stopPropagation()
      })
      wrapper.replaceChildren(textarea)
      textarea.focus()
    }

    renderDiagram()

    // 双击进入源码编辑态
    wrapper.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      editSource()
    })

    return {
      dom: wrapper,
      contentDOM: undefined,
      update: (next) => {
        if (next.type !== node.type) return false
        node = next
        renderDiagram()
        return true
      },
      ignoreMutation: () => true,
      selectNode: renderDiagram,
      deselectNode: renderDiagram,
      destroy: () => {
        reactRoot?.unmount()
        reactRoot = null
      }
    }
  }
})

// 双击进入编辑：通过包装 dom 事件监听实现（NodeView 本身不暴露 dblclick 钩子）。
// 这里在 view 工厂内对 dom 绑定 dblclick。
export function getMermaidType(ctx: Ctx): Node['type'] {
  return mermaidSchema.type(ctx)
}
