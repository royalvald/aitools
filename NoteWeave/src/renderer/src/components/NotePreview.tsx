import ReactMarkdown from 'react-markdown'
import { useSettings } from '../hooks/useSettings'
import {
  createMarkdownComponents,
  sharedRehypePlugins,
  sharedRemarkPlugins
} from '../lib/markdown-plugins'
import { ImageContextMenu } from './ImageContextMenu'
import { useImageContextMenu } from '../hooks/useImageContextMenu'

interface NotePreviewProps {
  markdown: string
  className?: string
  allowedElements?: string[]
  /** REQ-004 是否启用图片右键菜单（默认关闭，仅在正文预览开启）。 */
  enableImageMenu?: boolean
  /** REQ-004 删除图片回调（由父组件实现：删文件 + 清引用）。 */
  onRemoveImage?: (url: string) => void | Promise<void>
}

/**
 * 通用 Markdown 只读预览。
 *
 * 渲染能力由 lib/markdown-plugins 统一提供：GFM、LaTeX 公式（KaTeX）、
 * Mermaid 图表、代码语法高亮 + 复制按钮（行号由 settings.enableLineNumbers 控制）。
 */
export function NotePreview({
  markdown,
  className,
  allowedElements,
  enableImageMenu = false,
  onRemoveImage
}: NotePreviewProps) {
  const { settings } = useSettings()
  const imgMenu = useImageContextMenu()
  const components = createMarkdownComponents(undefined, {
    showLineNumbers: settings.enableLineNumbers,
    onImageContextMenu: enableImageMenu ? imgMenu.openFromEvent : undefined,
    onOpenImage: enableImageMenu ? (src) => window.electronAPI.openImageExternally(src) : undefined,
    onDeleteImage: enableImageMenu && onRemoveImage ? (src) => void onRemoveImage(src) : undefined
  })

  return (
    <div className={`markdown-body ${className || ''}`}>
      <ReactMarkdown
        remarkPlugins={[...sharedRemarkPlugins]}
        rehypePlugins={[...sharedRehypePlugins]}
        components={components}
        allowedElements={allowedElements}
        unwrapDisallowed
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
