// REQ-004/016 渲染进程资源上传辅助：
// - 从剪贴板读取图片（走主进程 clipboard：nativeImage），保存为 noteweave-asset:// 链接。
// - 从 File（拖拽 / 选择）读取图片/附件，保存后返回 Markdown 链接。

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i

export function isImageFile(name: string): boolean {
  return IMAGE_EXT_RE.test(name)
}

// 读取剪贴板图片并上传，返回 Markdown 图片语法；无图片返回 null。
export async function uploadClipboardImage(
  scope: 'note' | 'kb',
  ownerId: string
): Promise<string | null> {
  const data = await window.electronAPI.readClipboardImage()
  if (!data) return null
  const url = await window.electronAPI.saveImageAsset(scope, ownerId, data.buffer, data.ext)
  return `![](${url})`
}

// 读取一个 File（图片或附件）并上传，返回要插入的 Markdown 片段。
// 图片 → ![name](url)；附件 → [name](url)（点击由主进程协议打开本地文件）。
export async function uploadFile(
  file: File,
  scope: 'note' | 'kb',
  ownerId: string
): Promise<string> {
  const buffer = Array.from(new Uint8Array(await file.arrayBuffer()))
  const name = file.name
  if (isImageFile(name)) {
    const ext = name.split('.').pop() || 'png'
    const url = await window.electronAPI.saveImageAsset(scope, ownerId, buffer, ext)
    return `![${name.replace(/[![\]]/g, '')}](${url})`
  }
  const url = await window.electronAPI.saveAttachmentAsset(scope, ownerId, buffer, name)
  return `[📎 ${name}](${url})`
}
