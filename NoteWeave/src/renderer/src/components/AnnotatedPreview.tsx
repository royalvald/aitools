import ReactMarkdown from 'react-markdown'
import { useSettings } from '../hooks/useSettings'
import {
  createMarkdownComponents,
  sharedRehypePlugins,
  sharedRemarkPlugins
} from '../lib/markdown-plugins'
import { ImageContextMenu } from './ImageContextMenu'
import { useImageContextMenu } from '../hooks/useImageContextMenu'
import type { KbDocAnnotation } from '../types'
import { getAnnotationStatus } from '../lib/annotation'

interface AnnotatedPreviewProps {
  markdown: string
  annotations: KbDocAnnotation[]
  onAnnotationClick?: (annotation: KbDocAnnotation) => void
  onContextMenu?: (position: { x: number; y: number }) => void
  className?: string
  allowedElements?: string[]
  /** REQ-004 删除图片回调（删文件 + 清引用）。提供后启用图片右键菜单。 */
  onRemoveImage?: (url: string) => void | Promise<void>
}

// ---- hast 最小类型（避免引入 @types/hast，仅描述本插件用到的结构）----

interface HastText {
  type: 'text'
  value: string
}

interface HastElement {
  type: 'element'
  tagName: string
  properties: Record<string, unknown>
  children: HastNode[]
}

type HastNode = HastText | HastElement

interface HastRoot {
  type: 'root'
  children: HastNode[]
}

/**
 * 带批注高亮的 Markdown 预览。
 *
 * 实现方式（react-markdown v10 不再支持 components.text 覆盖文本节点）：
 * 通过自写的 rehype 插件，在 hast（HTML AST）阶段遍历 text 节点，
 * 把匹配批注 text 的子串包裹为 <mark> 元素（带 data-annotation-id / className / title）。
 * 再用 components.mark 把 <mark> 渲染为可点击的 <span>。
 *
 * 高亮策略（与创建时的「仅单段纯文本」限制对齐）：
 * - getAnnotationStatus 判定 valid/relocated/invalid；invalid 不高亮。
 * - 以「批注 text 是否为当前 text 节点 value 的子串」为准（content 偏移空间与纯文本不同）。
 */
export function AnnotatedPreview({
  markdown,
  annotations,
  onAnnotationClick,
  onContextMenu,
  className,
  allowedElements,
  onRemoveImage
}: AnnotatedPreviewProps) {
  const { settings } = useSettings()
  const imgMenu = useImageContextMenu()
  const enableImageMenu = !!onRemoveImage

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    // REQ-004：若右键的是应用协议图片，优先弹图片菜单。
    if (enableImageMenu) {
      const target = event.target as HTMLElement
      if (
        target instanceof HTMLImageElement &&
        target.currentSrc.startsWith('noteweave-asset:')
      ) {
        event.preventDefault()
        imgMenu.openFromEvent({ src: target.currentSrc, x: event.clientX, y: event.clientY })
        return
      }
    }
    event.preventDefault()
    onContextMenu?.({ x: event.clientX, y: event.clientY })
  }

  // 插件需要 annotations，故每次渲染生成新的插件实例
  const rehypeHighlight = createHighlightPlugin(annotations, markdown)

  // 批注 mark 覆盖优先（extra 在 createMarkdownComponents 中优先级高于 code）
  const components = createMarkdownComponents(
    {
      mark: ({ node: _node, ...props }) => {
        const id = (props as Record<string, unknown>).dataAnnotationId as string | undefined
        return (
          <mark
            {...props}
            className="annotation-highlight"
            onClick={(e) => {
              e.stopPropagation()
              const annotation = annotations.find((a) => a.id === id)
              if (annotation) onAnnotationClick?.(annotation)
            }}
          />
        )
      }
    },
    {
      showLineNumbers: settings.enableLineNumbers,
      onImageContextMenu: enableImageMenu ? imgMenu.openFromEvent : undefined,
      onOpenImage: enableImageMenu ? (src) => window.electronAPI.openImageExternally(src) : undefined,
      onDeleteImage: enableImageMenu && onRemoveImage ? (src) => void onRemoveImage(src) : undefined
    }
  )

  return (
    <div className={`markdown-body ${className || ''}`} onContextMenu={handleContextMenu}>
      <ReactMarkdown
        remarkPlugins={[...sharedRemarkPlugins]}
        // 批注高亮插件放在 KaTeX 之后，确保 text 节点切分在最终阶段执行
        rehypePlugins={[...sharedRehypePlugins, rehypeHighlight]}
        allowedElements={allowedElements}
        unwrapDisallowed
        components={components}
      >
        {markdown || ' '}
      </ReactMarkdown>
      {enableImageMenu && imgMenu.menu && (
        <ImageContextMenu
          position={{ x: imgMenu.menu.x, y: imgMenu.menu.y }}
          imageUrl={imgMenu.menu.url}
          onClose={imgMenu.close}
          onCopy={imgMenu.copyImage}
          onView={imgMenu.viewImage}
          onShowInFolder={imgMenu.showInFolder}
          onDelete={async (url) => {
            imgMenu.close()
            await onRemoveImage?.(url)
          }}
        />
      )}
    </div>
  )
}

/**
 * 构造一个 rehype 插件：遍历 hast 树，对每个 text 节点插入批注高亮 mark。
 * 闭包捕获 annotations / content，避免全局状态。
 */
function createHighlightPlugin(annotations: KbDocAnnotation[], content: string) {
  return function rehypeAnnotationHighlight() {
    return function transform(tree: HastRoot) {
      visit(tree)
    }
  }

  function visit(node: HastNode | HastRoot): void {
    const children = (node as { children?: HastNode[] }).children
    if (!children) return
    const next: HastNode[] = []
    for (const child of children) {
      if (child.type === 'text') {
        next.push(...splitText(child))
      } else {
        visit(child)
        next.push(child)
      }
    }
    ;(node as { children: HastNode[] }).children = next
  }

  /** 将一个 text 节点按批注命中位置切分为 [text, mark, text, ...] 序列 */
  function splitText(textNode: HastText): HastNode[] {
    const value = textNode.value
    if (!value) return [textNode]

    type Segment = { start: number; end: number; annotation: KbDocAnnotation }
    const segments: Segment[] = []

    for (const annotation of annotations) {
      const { status } = getAnnotationStatus(annotation, content)
      if (status === 'invalid') continue
      const idx = value.indexOf(annotation.text)
      if (idx !== -1) {
        segments.push({ start: idx, end: idx + annotation.text.length, annotation })
      }
    }

    if (segments.length === 0) return [textNode]

    segments.sort((a, b) => a.start - b.start || b.end - a.end)
    const nodes: HastNode[] = []
    let cursor = 0
    for (const seg of segments) {
      if (seg.start < cursor) continue // 跳过与前一段重叠的部分
      if (seg.start > cursor) {
        nodes.push({ type: 'text', value: value.slice(cursor, seg.start) })
      }
      nodes.push({
        type: 'element',
        tagName: 'mark',
        properties: {
          className: 'annotation-highlight',
          dataAnnotationId: seg.annotation.id,
          title: seg.annotation.content
        },
        children: [{ type: 'text', value: value.slice(seg.start, seg.end) }]
      })
      cursor = seg.end
    }
    if (cursor < value.length) {
      nodes.push({ type: 'text', value: value.slice(cursor) })
    }
    return nodes
  }
}
