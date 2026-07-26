import MDEditor from '@uiw/react-md-editor'
import { getCommands, getExtraCommands } from '@uiw/react-md-editor/commands-cn'
import { cn } from '../lib/utils'
import { useIsDark } from '../hooks/useIsDark'
import { uploadClipboardImage, uploadFile } from '../lib/assets'

interface NoteEditorProps {
  value: string
  onChange: (value: string) => void
  /** 固定像素高度或 '100%'。默认 '100%' 占满父级。 */
  height?: number | string
  hideToolbar?: boolean
  preview?: 'edit' | 'preview' | 'live'
  /** 外层包裹器样式；传 'h-full' 让编辑器随父级 flex 填满。 */
  className?: string
  /** REQ-004/016 资源归属（决定保存目录）。提供后启用图片粘贴/拖拽上传。 */
  assetScope?: { scope: 'note' | 'kb'; ownerId: string }
  /** REQ-113 拼写检查开关。 */
  spellcheck?: boolean
  /** 内部 textarea id，用于外部 <label htmlFor> 关联 */
  textareaId?: string
  /** 覆盖 textarea 占位提示（默认沿用标题/任务详情文案） */
  placeholder?: string
}

export function NoteEditor({
  value,
  onChange,
  height = '100%',
  hideToolbar = false,
  preview = 'edit',
  className,
  assetScope,
  spellcheck = false,
  textareaId,
  placeholder
}: NoteEditorProps) {
  // 传入字符串高度（如 '100%'）时编辑器内部用 flex 占满父级；传入数字时为固定像素。
  const isPercent = typeof height === 'string'
  // MDEditor 通过容器上的 data-color-mode 切换内置亮/暗配色，跟随应用 html.dark 主题
  const isDark = useIsDark()

  // REQ-004：粘贴图片（剪贴板含图片时上传并插入）
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (!assetScope) return
    const items = e.clipboardData?.items
    let handledFile = false
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) {
            // 仅在有文件项时阻止默认，避免影响纯文本粘贴
            if (!handledFile) e.preventDefault()
            handledFile = true
            const md = await uploadFile(file, assetScope.scope, assetScope.ownerId)
            insertAtCursor(md)
          }
        }
      }
    }
    if (handledFile) return
    // 无文件项时，尝试通过主进程读取剪贴板图片（截图场景，Chromium 不暴露 file item）
    const data = await window.electronAPI.readClipboardImage()
    if (data) {
      e.preventDefault()
      const url = await window.electronAPI.saveImageAsset(
        assetScope.scope,
        assetScope.ownerId,
        data.buffer,
        data.ext
      )
      insertAtCursor(`![](${url})`)
    }
  }

  // REQ-004/016：拖拽图片/附件到编辑器
  const handleDrop = async (e: React.DragEvent) => {
    if (!assetScope) return
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    const parts: string[] = []
    for (const file of Array.from(files)) {
      parts.push(await uploadFile(file, assetScope.scope, assetScope.ownerId))
    }
    insertAtCursor(parts.join('\n\n'))
  }

  // 在光标处插入文本（简单实现：追加到末尾，避免依赖 MDEditor 内部 ref）
  const insertAtCursor = (text: string) => {
    const ta = document.activeElement as HTMLTextAreaElement | null
    if (ta && ta.tagName === 'TEXTAREA') {
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = value.slice(0, start) + text + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        ta.focus()
        const pos = start + text.length
        ta.setSelectionRange(pos, pos)
      })
    } else {
      onChange(value + (value.endsWith('\n') || value === '' ? '' : '\n') + text)
    }
  }

  return (
    <div
      className={cn(isPercent && 'h-full', className)}
      data-color-mode={isDark ? 'dark' : 'light'}
      onPaste={handlePaste}
      onDrop={handleDrop}
    >
      <MDEditor
        value={value}
        onChange={(val) => onChange(val || '')}
        height={height}
        style={isPercent ? { height: '100%' } : undefined}
        preview={preview}
        hideToolbar={hideToolbar}
        commands={hideToolbar ? [] : getCommands()}
        extraCommands={hideToolbar ? [] : getExtraCommands()}
        textareaProps={{
          id: textareaId,
          placeholder:
            placeholder ??
            (hideToolbar ? '在此输入标题（支持 Markdown）' : '在此输入任务详情（支持 Markdown）'),
          spellCheck: spellcheck
        }}
      />
    </div>
  )
}
