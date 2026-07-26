import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import type { Whiteboard } from '../shared/types'
import { whiteboardToSvg, whiteboardToMarkdown } from '../shared/whiteboard-export'

// REQ-228 白板导出：PNG / SVG / Markdown 大纲。
// PNG 由渲染进程提供 dataURL（SVG→canvas 渲染），主进程解码写盘；
// SVG / Markdown 由纯函数生成，主进程直接写文本。
// 另含 REQ-224 白板框架导出 PDF（原 slides-doc.ts，随演示文稿文档类型移除迁入）。

export type WbExportFormat = 'png' | 'svg' | 'markdown'

export async function exportWhiteboard(
  wb: Whiteboard,
  format: WbExportFormat,
  pngDataUrl?: string
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) {
    return { success: false, filePath: null, error: '没有可用的窗口' }
  }
  const ext = format === 'png' ? 'png' : format === 'svg' ? 'svg' : 'md'
  const { filePath, canceled } = await dialog.showSaveDialog(window, {
    title: '导出白板',
    defaultPath: `whiteboard-${wb.docId.slice(0, 8)}.${ext}`,
    filters: [
      format === 'png'
        ? { name: 'PNG 图片', extensions: ['png'] }
        : format === 'svg'
        ? { name: 'SVG', extensions: ['svg'] }
        : { name: 'Markdown', extensions: ['md'] }
    ]
  })
  if (canceled || !filePath) {
    return { success: false, filePath: null }
  }
  try {
    if (format === 'svg') {
      await fs.writeFile(filePath, whiteboardToSvg(wb), 'utf-8')
    } else if (format === 'markdown') {
      await fs.writeFile(filePath, whiteboardToMarkdown(wb), 'utf-8')
    } else {
      if (!pngDataUrl) return { success: false, filePath: null, error: '缺少 PNG 数据' }
      const base64 = pngDataUrl.replace(/^data:image\/png;base64,/, '')
      await fs.writeFile(filePath, Buffer.from(base64, 'base64'))
    }
    return { success: true, filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, filePath: null, error: message }
  }
}

// REQ-224 白板框架导出为 PDF（每帧一页）：渲染进程提供每帧 SVG 字符串，
// 主进程把每个 SVG 包成独立 <section>（page-break-after），用离屏 BrowserWindow printToPDF。
export async function exportWhiteboardFramesPdf(
  kbId: string,
  docId: string,
  framesSvgs: string[]
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) {
    return { success: false, filePath: null, error: '没有可用的窗口' }
  }
  if (!framesSvgs.length) {
    return { success: false, filePath: null, error: '没有框架可导出' }
  }
  const { filePath, canceled } = await dialog.showSaveDialog(window, {
    title: '导出白板框架 PDF',
    defaultPath: `whiteboard-frames-${docId.slice(0, 8)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  })
  if (canceled || !filePath) {
    return { success: false, filePath: null }
  }
  const pages = framesSvgs
    .map(
      (svg) =>
        `<section class="frame-page">${svg}</section>`
    )
    .join('\n')
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  .frame-page { width: 960px; height: 720px; display: flex; align-items: center; justify-content: center; page-break-after: always; }
  .frame-page:last-child { page-break-after: auto; }
  svg { max-width: 100%; max-height: 100%; }
</style></head><body>${pages}</body></html>`
  const win = new BrowserWindow({ width: 1000, height: 750, show: false, webPreferences: { offscreen: false } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(fullHtml))
    await new Promise((resolve) => setTimeout(resolve, 600))
    const pdfData = await win.webContents.printToPDF({
      pageSize: { width: 96000, height: 72000 },
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    } as never)
    await fs.writeFile(filePath, pdfData)
    return { success: true, filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, filePath: null, error: message }
  } finally {
    win.destroy()
  }
  void kbId
}
