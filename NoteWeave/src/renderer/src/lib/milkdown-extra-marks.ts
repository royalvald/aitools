import { $remark, $markSchema, $command } from '@milkdown/utils'
import { toggleMark } from '@milkdown/prose/commands'
import type { Plugin, Transformer } from 'unified'
import type { Root, RootContent } from 'mdast'
import { remarkFootnoteLinksPlugin } from './footnote-links'

/**
 * 扩展内联标记（REQ-106）：高亮 ==x== / 下划线 ++x++（或 <u>x</u>）/
 * 上标 ^x^ / 下标 ~x~（单波浪号；双波浪号 ~~ 仍为 gfm 删除线）。
 *
 * 实现策略（务实、稳健）：
 * - 一个共享 remark 插件 remarkExtraMarks：把源码中的内联标记语法重写为对应 HTML
 *   片段（<mark>/<u>/<sup>/<sub>）。
 *   该插件同时用于：① react-markdown 预览端（NotePreview/AnnotatedPreview）
 *   ② Milkdown WYSIWYG 端（经 $remark 注入，markdown→ProseMirror 时被识别为 HTML 内联）
 *   ③ doc-export 的轻量渲染（在 markdownToHtml 中已能识别这些标签）。
 *   这样三端渲染一致，且不需要 Milkdown 自定义 mark 序列化（避免复杂的 toMarkdown runner）。
 * - Milkdown 仅注册 mark schema（parseDOM/toDOM），使 WYSIWYG 中通过工具栏/斜杠
 *   套用的 mark 也能在编辑态可见；序列化为 markdown 时这些 mark 会随 HTML 文本一并保留。
 */

// #region remark：内联标记语法 → mdast html 节点

type MdastNode = RootContent
type MdastParent = { children: MdastNode[] }

function remarkExtraMarksPlugin(): Plugin<[], Root> {
  const transformer: Transformer<Root> = (tree: Root): Root => {
    const visit = (node: MdastNode): void => {
      const parent = node as unknown as Partial<MdastParent>
      if (Array.isArray(parent.children)) {
        parent.children = rewriteAll(parent.children)
        for (const child of parent.children) visit(child)
      }
    }
    rootChildren(tree).forEach(visit)
    return tree
  }
  // 返回一个 Plugin（形如 () => transformer 的无配置插件）。
  return (() => transformer) as unknown as Plugin<[], Root>
}

function rootChildren(tree: Root): MdastNode[] {
  tree.children = rewriteAll(tree.children)
  return tree.children
}

// 递归扁平地把每段 text 切分为 text/html 节点
function rewriteAll(nodes: MdastNode[]): MdastNode[] {
  const out: MdastNode[] = []
  for (const node of nodes) {
    if (node.type === 'text' && 'value' in node) {
      out.push(...splitTextToHtml(String(node.value)))
    } else {
      out.push(node)
    }
  }
  return out
}

function splitTextToHtml(text: string): MdastNode[] {
  // withPrefix=true 的模式：m[1] 是前置字符（保留为纯文本），m[2] 才是标记内容；
  // 其余模式：m[1] 即标记内容。
  const patterns: { re: RegExp; tag: string; withPrefix?: boolean }[] = [
    { re: /==([^=\n]+?)==/g, tag: 'mark' },
    { re: /\+\+([^+\n]+?)\+\+/g, tag: 'u' },
    { re: /\^([^\^\n]+?)\^/g, tag: 'sup' },
    { re: /(^|[^~])~(?!~)([^~\n]+?)~/g, tag: 'sub', withPrefix: true } // 下标 ~x~，避免与 ~~ 冲突
  ]
  type Seg = { text: string; prefix?: string; tag?: string }
  let segs: Seg[] = [{ text }]
  for (const { re, tag, withPrefix } of patterns) {
    const next: Seg[] = []
    for (const seg of segs) {
      if (seg.tag) {
        next.push(seg)
        continue
      }
      let last = 0
      let m: RegExpExecArray | null
      re.lastIndex = 0
      let matched = false
      while ((m = re.exec(seg.text)) !== null) {
        matched = true
        const prefix = withPrefix ? m[1] : ''
        const content = (withPrefix ? m[2] : m[1]) ?? ''
        const cut = m.index + prefix.length
        if (cut > last) next.push({ text: seg.text.slice(last, cut) })
        next.push({ text: content, tag })
        last = m.index + m[0].length
      }
      if (!matched) {
        next.push(seg)
        continue
      }
      if (last < seg.text.length) next.push({ text: seg.text.slice(last) })
    }
    segs = next
  }
  const result: MdastNode[] = []
  for (const s of segs) {
    if (!s.text && !s.tag) continue
    if (s.tag) {
      result.push({ type: 'html', value: `<${s.tag}>${escapeHtml(s.text)}</${s.tag}>` } as never)
    } else if (s.text) {
      result.push({ type: 'text', value: s.text } as never)
    }
  }
  return result.length ? result : [{ type: 'text', value: text } as never]
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Milkdown 注入：$remark 把插件 push 进 markdown 解析管线。
export const remarkExtraMarks = $remark('remarkExtraMarks', () => {
  return function plugin(): import('unified').Transformer<import('mdast').Root> {
    const factory = remarkExtraMarksPlugin() as unknown as {
      (): import('unified').Transformer<import('mdast').Root>
    }
    return factory()
  } as never
})

// 预览端（react-markdown）直接使用的同一插件工厂（导出给 markdown-plugins.tsx）。
export const remarkExtraMarksPluginFactory = remarkExtraMarksPlugin

// #endregion

// #region Milkdown mark schema（WYSIWYG 编辑态可见）

const makeMark = (id: string, tag: string) =>
  $markSchema(id, () => ({
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0],
    // 序列化/解析交由 remark 插件（HTML 内联）处理；此处提供空 runner 满足 schema 约定。
    parseMarkdown: {
      match: () => false,
      runner: () => {}
    },
    toMarkdown: {
      match: () => false,
      runner: () => {}
    }
  }))

export const highlightMark = makeMark('highlight', 'mark')
export const underlineMark = makeMark('underline', 'u')
export const superscriptMark = makeMark('superscript', 'sup')
export const subscriptMark = makeMark('subscript', 'sub')

// toggle 命令（斜杠命令 / 工具栏调用）
const makeToggle = (id: string, markName: string) =>
  $command(`toggle${id}`, () => () => {
    return (state, dispatch) => {
      const type = state.schema.marks[markName]
      if (!type) return false
      return toggleMark(type)(state, dispatch)
    }
  })

export const toggleHighlight = makeToggle('Highlight', 'highlight')
export const toggleUnderline = makeToggle('Underline', 'underline')
export const toggleSuperscript = makeToggle('Superscript', 'superscript')
export const toggleSubscript = makeToggle('Subscript', 'subscript')

// 一次性 .use() 的插件集合
export const extraMarksPlugins = [
  remarkExtraMarks,
  highlightMark,
  underlineMark,
  superscriptMark,
  subscriptMark,
  toggleHighlight,
  toggleUnderline,
  toggleSuperscript,
  toggleSubscript
]

// 命令键集合
export const extraMarksCommands = {
  highlight: toggleHighlight.key,
  underline: toggleUnderline.key,
  superscript: toggleSuperscript.key,
  subscript: toggleSubscript.key
}

// REQ-104：Milkdown 编辑端脚注引用/定义 → 可点击 HTML 锚点（点击滚动到定义）
export const remarkFootnoteLinks = $remark('remarkFootnoteLinks', () => {
  return remarkFootnoteLinksPlugin() as never
})

// #region rehype：预览端（react-markdown）内联标记 → hast 元素节点
//
// 预览端不走 remark 版（remark 版产出 mdast html 节点，react-markdown 默认转义，
// 需要 rehype-raw 才能还原）。这里直接在 hast 阶段把 text 节点中的
// ==x== / ++x++ / ^x^ / ~x~ 包裹为真实 <mark>/<u>/<sup>/<sub> 元素，零额外依赖。

interface HastTextNode {
  type: 'text'
  value: string
}

interface HastElementNode {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}

type HastNode = HastTextNode | HastElementNode

const EXTRA_MARK_TAGS: { re: RegExp; tag: string; withPrefix?: boolean }[] = [
  { re: /==([^=\n]+?)==/g, tag: 'mark' },
  { re: /\+\+([^+\n]+?)\+\+/g, tag: 'u' },
  { re: /\^([^\^\n]+?)\^/g, tag: 'sup' },
  { re: /(^|[^~])~(?!~)([^~\n]+?)~/g, tag: 'sub', withPrefix: true }
]

function splitHastText(value: string): HastNode[] {
  type Seg = { text: string; tag?: string }
  let segs: Seg[] = [{ text: value }]
  for (const { re, tag, withPrefix } of EXTRA_MARK_TAGS) {
    const next: Seg[] = []
    for (const seg of segs) {
      if (seg.tag) {
        next.push(seg)
        continue
      }
      let last = 0
      let m: RegExpExecArray | null
      let matched = false
      re.lastIndex = 0
      while ((m = re.exec(seg.text)) !== null) {
        matched = true
        const prefix = withPrefix ? m[1] : ''
        const content = (withPrefix ? m[2] : m[1]) ?? ''
        const cut = m.index + prefix.length
        if (cut > last) next.push({ text: seg.text.slice(last, cut) })
        next.push({ text: content, tag })
        last = m.index + m[0].length
      }
      if (!matched) {
        next.push(seg)
        continue
      }
      if (last < seg.text.length) next.push({ text: seg.text.slice(last) })
    }
    segs = next
  }
  return segs
    .filter((s) => s.text || s.tag)
    .map((s) =>
      s.tag
        ? {
            type: 'element',
            tagName: s.tag,
            properties: {},
            children: [{ type: 'text', value: s.text }]
          }
        : { type: 'text', value: s.text }
    )
}

/** rehype 插件：预览端扩展内联标记。跳过 code/pre 与 KaTeX math 节点内部。 */
export function rehypeExtraMarksPlugin() {
  return function transformer(tree: { type: string; children?: HastNode[] }) {
    const visit = (node: { tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }) => {
      const classes = (node.properties?.className as (string | number)[] | undefined) ?? []
      if (
        node.tagName === 'code' ||
        node.tagName === 'pre' ||
        classes.some((c) => String(c).startsWith('math'))
      ) {
        return
      }
      if (!Array.isArray(node.children)) return
      const next: HastNode[] = []
      for (const child of node.children) {
        if (child.type === 'text') {
          next.push(...splitHastText(child.value))
        } else {
          visit(child)
          next.push(child)
        }
      }
      node.children = next
    }
    visit(tree)
  }
}

// #endregion
