import { $ctx, $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

// WYSIWYG 空文档占位提示（Typora 式）。
//
// 仅当整篇文档只剩一个空文本块时，在该块上挂 data-placeholder 属性，
// 由 CSS ::before 渲染提示文字（见 index.css 的 .milkdown-placeholder 规则）。
// 用 ProseMirror decorations 实现：无需操作 DOM，输入/删除后自动消失/复现。

export const placeholderTextCtx = $ctx('输入 / 开始，或输入 Markdown', 'placeholderTextCtx')

export const placeholderPlugin = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey('milkdown-placeholder'),
      props: {
        decorations(state) {
          const { doc } = state
          const first = doc.firstChild
          if (doc.childCount === 1 && first && first.isTextblock && first.content.size === 0) {
            return DecorationSet.create(doc, [
              Decoration.node(0, first.nodeSize, {
                class: 'milkdown-placeholder',
                'data-placeholder': ctx.get(placeholderTextCtx.key)
              })
            ])
          }
          return null
        }
      }
    })
)
