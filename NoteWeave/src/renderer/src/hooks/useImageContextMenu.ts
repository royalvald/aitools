import { useCallback, useState } from 'react'

interface ImageMenuState {
  url: string
  x: number
  y: number
}

export interface ImageContextMenuApi {
  /** 当前菜单状态，null 表示不显示 */
  menu: ImageMenuState | null
  /** 供 markdown-plugins 的 img onContextMenu 调用 */
  openFromEvent: (payload: { src: string; x: number; y: number }) => void
  close: () => void
  /** 复制图片到剪贴板 */
  copyImage: (url: string) => Promise<void>
  /** 用系统查看器打开 */
  viewImage: (url: string) => Promise<void>
  /** 在文件夹中显示 */
  showInFolder: (url: string) => Promise<void>
}

// REQ-004 图片右键菜单的统一状态与操作。
// 删除（删文件 + 清引用）依赖具体编辑器/内容，由组件层在 onRemoveImage 中实现。
export function useImageContextMenu(): ImageContextMenuApi {
  const [menu, setMenu] = useState<ImageMenuState | null>(null)

  const openFromEvent = useCallback((payload: { src: string; x: number; y: number }) => {
    setMenu({ url: payload.src, x: payload.x, y: payload.y })
  }, [])

  const close = useCallback(() => setMenu(null), [])

  const copyImage = useCallback(async (url: string) => {
    await window.electronAPI.writeClipboardImage(url)
    setMenu(null)
  }, [])

  const viewImage = useCallback(async (url: string) => {
    await window.electronAPI.openImageExternally(url)
    setMenu(null)
  }, [])

  const showInFolder = useCallback(async (url: string) => {
    await window.electronAPI.showAssetInFolder(url)
    setMenu(null)
  }, [])

  return { menu, openFromEvent, close, copyImage, viewImage, showInFolder }
}
