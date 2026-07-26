import katex from 'katex'
import remarkMath from 'remark-math'
import { $remark, $nodeSchema, $view } from '@milkdown/utils'
import type { Ctx } from '@milkdown/ctx'
import type { Node } from '@milkdown/prose/model'
import type { EditorView, NodeViewConstructor } from '@milkdown/prose/view'

/**
 * Milkdown WYSIWYG 编辑态 LaTeX 公式支持（REQ-002）。
 *
 * 预览端已用 react-markdown + remark-math + rehype-katex 渲染；本文件让 Milkdown
 * 编辑端同样渲染公式，达到 WYSIWYG 与预览一致。
 *
 * 实现路径（全部复用已安装依赖，无新增包）：
 * - remark：注入 remark-math，把 `$...$` / `$$...$$` 解析为 mdast 的 inlineMath / math 节点。
 * - schema：用 $nodeSchema 定义 math_inline（inline atom）/ math_block（block atom）两个
 *   ProseMirror 节点，attrs.value 存原始 LaTeX 源码。
 * - view：用 $view 注册原生 NodeView，调用 katex.renderToString 渲染到 DOM；选中节点时
 *   切换为可编辑 textarea，失焦后把新值写回 attrs（dispatch transaction）。
 *
 * KaTeX 样式复用 markdown-plugins.tsx 全局 import 的 katex.min.css。
 */

// remark-math 注入。$remark 把插件 push 进 Milkdown 的 remark pipeline。
export const remarkMathPlugin = $remark('remarkMath', () => remarkMath as never)

// 行内公式节点：对应 mdast 的 inlineMath。
export const mathInlineSchema = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    value: { default: '' }
  },
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => {
      state.addNode('inlineMath', undefined, node.attrs.value)
    }
  }
}))

// 块级公式节点：对应 mdast 的 math。
export const mathBlockSchema = $nodeSchema('math_block', () => ({
  group: 'block',
  atom: true,
  attrs: {
    value: { default: '' }
  },
  parseMarkdown: {
    match: (node) => node.type === 'math',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string })
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => {
      state.addNode('math', undefined, node.attrs.value)
    }
  }
}))

/**
 * 构造一个公式 NodeView 工厂。inline / block 共用同一逻辑，仅 displayMode 与标签不同。
 *
 * 选中态（selectNode）下显示 textarea 让用户修改 LaTeX 源码；非选中态显示 KaTeX 渲染结果。
 */
function createMathNodeView(displayMode: boolean): (ctx: Ctx) => NodeViewConstructor {
  return (_ctx: Ctx) => (node: Node, view: EditorView, getPos: () => number | undefined) => {
    const wrapper = document.createElement(displayMode ? 'div' : 'span')
    wrapper.classList.add(displayMode ? 'milkdown-math-block' : 'milkdown-math-inline')
    wrapper.style.display = displayMode ? 'block' : 'inline-block'

    const renderDom = (): void => {
      const value = (node.attrs.value as string) ?? ''
      try {
        wrapper.innerHTML = katex.renderToString(value, {
          displayMode,
          throwOnError: false,
          strict: false,
          output: 'html'
        })
      } catch {
        // 渲染失败时显示源码，避免阻断编辑
        wrapper.textContent = value
      }
    }

    const editDom = (): void => {
      const textarea = document.createElement('textarea')
      textarea.value = (node.attrs.value as string) ?? ''
      textarea.rows = displayMode ? 3 : 1
      textarea.className = 'milkdown-math-input'
      // 失焦 / Ctrl+Enter 写回 attrs
      const commit = (): void => {
        const pos = getPos()
        if (pos === undefined) return
        const next = textarea.value
        const tr = view.state.tr.setNodeMarkup(pos, undefined, { value: next })
        view.dispatch(tr)
        view.focus()
      }
      textarea.addEventListener('blur', commit)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          commit()
        }
        // Esc 放弃修改（直接失焦，commit 会把当前文本写回；这里阻止 Esc 退出）
        e.stopPropagation()
      })
      wrapper.replaceChildren(textarea)
      textarea.focus()
    }

    renderDom()

    return {
      dom: wrapper,
      contentDOM: undefined,
      // attrs 变化时重新渲染（节点类型相同才接管）
      update: (next) => {
        if (next.type !== node.type) return false
        node = next
        renderDom()
        return true
      },
      selectNode: () => {
        editDom()
      },
      deselectNode: () => {
        renderDom()
      },
      // 忽略 DOM 变更（KaTeX 注入的内部结构不触发事务）
      ignoreMutation: () => true,
      stopEvent: () => false
    }
  }
}

export const mathInlineView = $view(mathInlineSchema.node, createMathNodeView(false))
export const mathBlockView = $view(mathBlockSchema.node, createMathNodeView(true))

// 供斜杠命令菜单使用：拿到块级公式的 NodeType。
export function getMathBlockType(ctx: Ctx): Node['type'] {
  return mathBlockSchema.type(ctx)
}
