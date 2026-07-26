import { useState } from 'react'
import type { Components } from 'react-markdown'
import type { Plugin } from 'unified'
import type { Root } from 'mdast'
import { Eye, Trash2 } from 'lucide-react'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkFrontmatter from 'remark-frontmatter'
import remarkFootnotes from 'remark-footnotes'
import { rehypeExtraMarksPlugin } from './milkdown-extra-marks'
import { CodeBlock } from '../components/CodeBlock'
import { MermaidDiagram } from '../components/MermaidDiagram'
import { DiagramBlock } from '../components/DiagramBlock'

// KaTeX 样式（含字体）。Vite 会处理字体资源的打包与 hash 命名。
import 'katex/dist/katex.min.css'

/**
 * 统一的 Markdown 渲染插件与组件配置（REQ-002 LaTeX / REQ-003 Mermaid / REQ-009 代码高亮）。
 *
 * 所有 react-markdown 预览端（NotePreview / AnnotatedPreview）共享本配置：
 * - remark 插件：gfm（表格/任务列表/删除线）+ math（$..$ 与 $$..$$）。
 * - rehype 插件：katex（把数学节点渲染为 KaTeX HTML）。
 * - components：
 *   - code：mermaid 语言 → <MermaidDiagram>；否则 → <CodeBlock>（语法高亮 + 复制）。
 *     行内 code（无 className 或 inline）保持原样。
 *
 * AnnotatedPreview 需要额外覆盖 mark 节点（批注高亮），通过 createMarkdownComponents(extra)
 * 传入额外的 components 覆盖（mark 等），与默认 code 覆盖合并。
 */

// REQ-103 front-matter：解析但不渲染（yaml 节点），通过空渲染兜底过滤。
// REQ-104 footnotes：底部脚注定义与上标引用。
// 注意顺序：frontmatter 必须先于 gfm/math，footnotes 紧随其后。
export const sharedRemarkPlugins: Plugin<[], Root>[] = [
  remarkFrontmatter as Plugin<[], Root>,
  remarkGfm as Plugin<[], Root>,
  remarkMath as Plugin<[], Root>,
  remarkFootnotes as Plugin<[], Root>
]
// REQ-106 扩展内联标记：在 hast 阶段处理（remark 版会产出被 react-markdown 转义的 html 节点）；
// 先于 katex 执行，插件内部跳过 code/pre 与 math 节点。
export const sharedRehypePlugins = [rehypeExtraMarksPlugin, rehypeKatex] as const

interface CreateComponentsOptions {
  /** 代码块是否显示行号（来自 settings.enableLineNumbers）。默认 false。 */
  showLineNumbers?: boolean
  /** REQ-004：图片右键回调，传入图片 src 与鼠标位置。 */
  onImageContextMenu?: (payload: { src: string; x: number; y: number }) => void
  /** 图片 hover 工具栏：在外部查看器中打开。 */
  onOpenImage?: (src: string) => void
  /** 图片 hover 工具栏：删除图片（清理引用）。 */
  onDeleteImage?: (src: string) => void
}

/**
 * 从 react-markdown 透传的 code 节点 props 中解析出语言与代码文本。
 *
 * react-markdown v10 的 code 组件：
 * - 块级：<code className="language-xxx">...</code>，可通过 node 判断；inline 为 { inline: true }。
 * - children 为文本或数组。
 */
function parseCodeProps(props: Record<string, unknown>): {
  inline: boolean
  language: string
  value: string
} {
  const inline = Boolean(props.inline)
  const className = (props.className as string | undefined) ?? ''
  const langMatch = /language-(\w+)/.exec(className)
  const language = langMatch ? langMatch[1] : ''
  const raw = props.children
  const value = Array.isArray(raw)
    ? raw.map((c) => (typeof c === 'string' ? c : '')).join('')
    : typeof raw === 'string'
      ? raw
      : String(raw ?? '')
  return { inline, language, value }
}

/**
 * 构造 react-markdown 的 components 配置。
 * @param extra 额外的组件覆盖（如批注 mark），会与默认 code 覆盖合并，extra 优先级更高。
 */
export function createMarkdownComponents(
  extra?: Components,
  options: CreateComponentsOptions = {}
): Components {
  const { showLineNumbers = false, onImageContextMenu, onOpenImage, onDeleteImage } = options
  return {
    ...extra,
    img(props) {
      const { src } = props as { src?: string }
      const [hover, setHover] = useState(false)
      const isAppAsset = src?.startsWith('noteweave-asset:')
      const showToolbar = isAppAsset && (onOpenImage || onDeleteImage)

      const handleContextMenu = (e: React.MouseEvent<HTMLImageElement>) => {
        if (!onImageContextMenu || !src) return
        if (!isAppAsset) return
        e.preventDefault()
        onImageContextMenu({ src, x: e.clientX, y: e.clientY })
      }

      // eslint-disable-next-line jsx-a11y/alt-text
      const imgNode = <img {...props} onContextMenu={handleContextMenu} />

      if (!showToolbar) return imgNode

      return (
        <span
          className="relative inline-block max-w-full"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {imgNode}
          {hover && (
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5 shadow-md">
              {onOpenImage && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (src) onOpenImage(src)
                  }}
                  className="btn-icon"
                  title="在外部查看器中打开"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
              {onDeleteImage && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (src) onDeleteImage(src)
                  }}
                  className="btn-icon text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
                  title="删除图片"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          )}
        </span>
      )
    },
    code(props) {
      const { inline, language, value } = parseCodeProps(
        props as Record<string, unknown>
      )
      if (inline) {
        return <code>{value}</code>
      }
      if (language === 'mermaid') {
        return <MermaidDiagram chart={value} />
      }
      if (language === 'plantuml' || language === 'puml') {
        return <DiagramBlock kind="plantuml" source={value} />
      }
      if (language === 'dot' || language === 'graphviz') {
        return <DiagramBlock kind="graphviz" source={value} />
      }
      return <CodeBlock language={language} value={value} showLineNumbers={showLineNumbers} />
    }
  }
}
