import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { MindmapData } from '../shared/types'
import { createKbDoc, saveKbDoc, getKnowledgeBasesDir } from './store'
import { defaultMindmapData, mindmapFromMarkdown, mindmapToOpml } from '../shared/mindmap-helpers'

// REQ-212 思维导图存储与导出。
// 数据以 JSON 存储：{userData}/knowledge-bases/{kbId}/{docId}.mindmap.json

const MINDMAP_SUFFIX = '.mindmap.json'

function getMindmapPath(kbId: string, docId: string): string {
  return path.join(getKnowledgeBasesDir(), kbId, `${docId}${MINDMAP_SUFFIX}`)
}

export async function createMindmapDoc(
  kbId: string,
  name: string
): Promise<{ docId: string; kbId: string; data: MindmapData }> {
  const doc = await createKbDoc(kbId, name)
  await saveKbDoc({ ...doc, docType: 'mindmap', content: '' })
  const data = defaultMindmapData()
  await fs.writeFile(getMindmapPath(kbId, doc.id), JSON.stringify(data, null, 2), 'utf-8')
  return { docId: doc.id, kbId, data }
}

export async function getMindmapDoc(kbId: string, docId: string): Promise<MindmapData | null> {
  try {
    const raw = await fs.readFile(getMindmapPath(kbId, docId), 'utf-8')
    return JSON.parse(raw) as MindmapData
  } catch {
    return null
  }
}

export async function saveMindmapDoc(
  kbId: string,
  docId: string,
  data: MindmapData
): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(getMindmapPath(kbId, docId)), { recursive: true })
    await fs.writeFile(getMindmapPath(kbId, docId), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

export async function mindmapDocFromMarkdown(
  kbId: string,
  docId: string,
  markdown: string
): Promise<boolean> {
  const data = mindmapFromMarkdown(markdown)
  return saveMindmapDoc(kbId, docId, data)
}

export async function exportMindmapDoc(
  kbId: string,
  docId: string,
  format: 'opml' | 'png',
  pngDataUrl?: string
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) {
    return { success: false, filePath: null, error: '没有可用的窗口' }
  }
  const data = await getMindmapDoc(kbId, docId)
  if (!data) {
    return { success: false, filePath: null, error: '思维导图数据不存在' }
  }

  const ext = format === 'opml' ? 'opml' : 'png'
  const { filePath, canceled } = await dialog.showSaveDialog(window, {
    title: '导出思维导图',
    defaultPath: `mindmap-${docId.slice(0, 8)}.${ext}`,
    filters: [
      format === 'opml'
        ? { name: 'OPML', extensions: ['opml'] }
        : { name: 'PNG 图片', extensions: ['png'] }
    ]
  })
  if (canceled || !filePath) {
    return { success: false, filePath: null }
  }

  try {
    if (format === 'opml') {
      await fs.writeFile(filePath, mindmapToOpml(data), 'utf-8')
    } else {
      // PNG：由渲染进程生成 dataURL（SVG→canvas）后传入
      if (!pngDataUrl) {
        return { success: false, filePath: null, error: '缺少 PNG 数据' }
      }
      const base64 = pngDataUrl.replace(/^data:image\/png;base64,/, '')
      await fs.writeFile(filePath, Buffer.from(base64, 'base64'))
    }
    return { success: true, filePath }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, filePath: null, error: message }
  }
}

export const __test__ = { getMindmapPath }
