import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import type { ImportedDoc, ImportExternalResult } from '../shared/types'
import { safeDocName, stripNotionUuid } from '../shared/import-converters'
import { createKbDoc, saveKbDoc, saveImageAsset, createKnowledgeBase } from './store'

// REQ-209 批量导入外部格式：.docx（mammoth）/ .html（turndown）/ .md / .txt / Notion 导出 ZIP。
// 导入后生成报告：成功数（imported）、失败文件（failed）、跳过的图片（skippedImages）。

let turndownCtor: ((new (opts?: unknown) => {
  turndown: (html: string) => string
}) | null) = null

async function getTurndown() {
  if (turndownCtor) return turndownCtor
  // 动态加载，避免影响不支持该依赖的环境
  const mod = (await import('turndown')) as unknown as { default?: unknown; TurndownService?: unknown }
  turndownCtor = (mod.default ?? mod.TurndownService) as typeof turndownCtor
  return turndownCtor
}

// 将 HTML 转为 Markdown（复用 turndown 实例）
async function htmlToMarkdown(html: string): Promise<string> {
  const Ctor = await getTurndown()
  if (!Ctor) {
    // 退化：去掉标签
    return html.replace(/<[^>]+>/g, '')
  }
  const td = new Ctor({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  return td.turndown(html)
}

// .docx → Markdown：mammoth 先转 HTML（提取图片为 base64 内联），再 turndown 转 Markdown
async function docxToMarkdown(
  buffer: Buffer,
  ctx: ConversionContext
): Promise<{ markdown: string; imageBuffers: { name: string; buffer: Buffer }[] }> {
  void ctx
  const mammoth = (await import('mammoth')) as unknown as {
    convertToHtml: (
      input: { buffer: Buffer },
      options?: {
        convertImage?: {
          convert: (img: MammothImage) => Promise<{ src: string }>
        }
      }
    ) => Promise<{ value: string; messages: unknown[] }>
  }
  const images: { name: string; buffer: Buffer }[] = []
  let imageCounter = 0
  const options = {
    convertImage: {
      convert: async (img: MammothImage) => {
        const idx = imageCounter++
        const name = `image-${idx}.png`
        const b64 = await img.read('base64')
        images.push({ name, buffer: Buffer.from(b64, 'base64') })
        return { src: `__IMPORT_IMG_PLACEHOLDER__${name}__` }
      }
    }
  }
  const result = await mammoth.convertToHtml({ buffer }, options)
  // 把占位 src 替换为 markdown 图片占位（后续由调用方落盘并替换为 asset URL）
  let html = result.value
  const placeholderRe = /__IMPORT_IMG_PLACEHOLDER__([^_]+)__/g
  html = html.replace(placeholderRe, (_m, name) => `__IMPORT_IMG__${name}__`)
  const markdown = await htmlToMarkdown(html)
  return { markdown, imageBuffers: images }
}

interface MammothImage {
  read: (encoding: string) => Promise<string>
  contentType: string
}

// 导入图片资源到目标知识库，并返回 markdown 中可用的 asset URL
interface ConversionContext {
  kbId: string
  skippedImages: string[]
}

async function materializeImages(
  markdown: string,
  images: { name: string; buffer: Buffer }[],
  ctx: ConversionContext
): Promise<string> {
  if (images.length === 0) return markdown
  let out = markdown
  for (const img of images) {
    const placeholder = `__IMPORT_IMG__${img.name}__`
    if (!out.includes(placeholder)) {
      ctx.skippedImages.push(img.name)
      continue
    }
    const ext = path.extname(img.name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png'
    try {
      const url = await saveImageAsset('kb', ctx.kbId, img.buffer, ext)
      out = out.split(placeholder).join(url)
    } catch {
      ctx.skippedImages.push(img.name)
    }
  }
  // 残留的占位符清理掉
  out = out.replace(/__IMPORT_IMG__[^_]+__/g, '')
  return out
}

// .md / .txt：直接读取，.txt 转为代码块或纯文本
async function textToMarkdown(buffer: Buffer, ext: string): Promise<string> {
  const text = buffer.toString('utf-8')
  if (ext === '.txt') {
    // 纯文本：按行保留，不做转换
    return text
  }
  return text
}

// Notion 导出 ZIP：解压后读取 .md 文件（含 UUID 文件名），重建层级为扁平标题列表。
// Notion 导出常见结构：<根文件夹>/*.md + 子文件夹/*.md，文件名形如 "标题 abc123def.md"。
async function convertNotionZip(
  zip: JSZip,
  ctx: ConversionContext
): Promise<{ docs: ImportedDoc[]; failed: { file: string; reason: string }[] }> {
  const docs: ImportedDoc[] = []
  const failed: { file: string; reason: string }[] = []
  // Notion 图片通常在同名文件夹下，这里简化：收集所有图片条目按文件名索引
  const imageEntries = Object.values(zip.files).filter(
    (e) => !e.dir && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(e.name)
  )

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    if (entry.name.startsWith('__MACOSX/')) continue
    if (!/\.md$/i.test(entry.name)) continue
    try {
      const raw = await entry.async('string')
      // Notion 标题：去掉末尾的 32 位 UUID（abc123def456...）
      const title = stripNotionUuid(safeDocName(entry.name))
      // 替换 Notion 图片引用为占位，再落盘
      let md = raw
      // Notion 图片格式：![alt](标题%20abc123.png) 或相对路径
      const imgRefRe = /!\[([^\]]*)\]\(([^)]+)\)/g
      const placeholders: { name: string; buffer: Buffer }[] = []
      md = md.replace(imgRefRe, (match, alt, url) => {
        // 解析图片文件名（URL 解码最后一个路径段）
        try {
          const decoded = decodeURIComponent(url)
          const fileName = path.basename(decoded)
          const entry2 = imageEntries.find((ie) => path.basename(ie.name) === fileName)
          if (entry2) {
            // 同步收集，稍后落盘（这里用占位，下面 await）
            placeholders.push({ name: fileName, buffer: Buffer.alloc(0) })
            const idx = placeholders.length - 1
            return `![${alt}](__NOTION_IMG_${idx}__${fileName})`
          }
        } catch {
          // ignore
        }
        return match
      })
      // 异步加载图片 buffer
      for (let i = 0; i < placeholders.length; i++) {
        const p = placeholders[i]
        const fileName = p.name
        const entry2 = imageEntries.find((ie) => path.basename(ie.name) === fileName)
        if (entry2) {
          try {
            p.buffer = await entry2.async('nodebuffer')
          } catch {
            ctx.skippedImages.push(fileName)
          }
        }
      }
      // 落盘图片
      let finalMd = md
      for (let i = 0; i < placeholders.length; i++) {
        const p = placeholders[i]
        const token = `__NOTION_IMG_${i}__`
        if (!p.buffer || p.buffer.length === 0) {
          finalMd = finalMd.split(token).join('')
          if (p.name) ctx.skippedImages.push(p.name)
          continue
        }
        const ext = path.extname(p.name).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png'
        try {
          const url = await saveImageAsset('kb', ctx.kbId, p.buffer, ext)
          finalMd = finalMd.split(token + p.name).join(url)
        } catch {
          ctx.skippedImages.push(p.name)
          finalMd = finalMd.split(token).join('')
        }
      }
      docs.push({ name: title, content: finalMd, sourceType: 'notion' })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push({ file: entry.name, reason })
    }
  }
  return { docs, failed }
}

// 单文件转换
async function convertFile(
  fileName: string,
  buffer: Buffer,
  ctx: ConversionContext
): Promise<{ doc?: ImportedDoc; failed?: { file: string; reason: string } }> {
  const ext = path.extname(fileName).toLowerCase()
  try {
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
      const markdown = await textToMarkdown(buffer, ext)
      return {
        doc: {
          name: safeDocName(fileName),
          content: markdown,
          sourceType: ext === '.txt' ? 'txt' : 'md'
        }
      }
    }
    if (ext === '.html' || ext === '.htm') {
      const html = buffer.toString('utf-8')
      const markdown = await htmlToMarkdown(html)
      return { doc: { name: safeDocName(fileName), content: markdown, sourceType: 'html' } }
    }
    if (ext === '.docx') {
      const { markdown, imageBuffers } = await docxToMarkdown(buffer, ctx)
      const finalMd = await materializeImages(markdown, imageBuffers, ctx)
      return { doc: { name: safeDocName(fileName), content: finalMd, sourceType: 'docx' } }
    }
    return { failed: { file: fileName, reason: `不支持的文件类型：${ext}` } }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { failed: { file: fileName, reason } }
  }
}

// 主入口：弹出文件选择对话框，转换并导入到目标知识库。
export async function importExternalFiles(
  kbId: string | null
): Promise<ImportExternalResult> {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) {
    return { success: false, imported: [], failed: [], skippedImages: [], error: '没有可用的窗口' }
  }

  const { filePaths, canceled } = await dialog.showOpenDialog(window, {
    title: '导入外部文件',
    filters: [
      { name: '文档与归档', extensions: ['docx', 'html', 'htm', 'md', 'markdown', 'txt', 'zip'] }
    ],
    properties: ['openFile', 'multiSelections']
  })

  if (canceled || !filePaths || filePaths.length === 0) {
    return { success: false, imported: [], failed: [], skippedImages: [] }
  }

  // 确定目标知识库：若未提供，则询问用户创建新知识库或选择现有
  let targetKbId = kbId
  if (!targetKbId) {
    const created = await createKnowledgeBase('导入的知识库', '导入')
    targetKbId = created.id
  }

  const ctx: ConversionContext = { kbId: targetKbId, skippedImages: [] }
  const imported: string[] = []
  const failed: { file: string; reason: string }[] = []

  for (const filePath of filePaths) {
    const ext = path.extname(filePath).toLowerCase()
    // Notion ZIP：解压并批量转换
    if (ext === '.zip') {
      try {
        const buf = await fs.readFile(filePath)
        const zip = await JSZip.loadAsync(buf)
        const { docs, failed: zipFailed } = await convertNotionZip(zip, ctx)
        failed.push(...zipFailed)
        for (const doc of docs) {
          try {
            const created = await createKbDoc(targetKbId, doc.name)
            await saveKbDoc({ ...created, content: doc.content })
            imported.push(doc.name)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            failed.push({ file: doc.name, reason })
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        failed.push({ file: path.basename(filePath), reason: `ZIP 解析失败：${reason}` })
      }
      continue
    }

    // 普通文件
    try {
      const buf = await fs.readFile(filePath)
      const { doc, failed: fail } = await convertFile(filePath, buf, ctx)
      if (fail) {
        failed.push(fail)
        continue
      }
      if (doc) {
        const created = await createKbDoc(targetKbId, doc.name)
        await saveKbDoc({ ...created, content: doc.content })
        imported.push(doc.name)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      failed.push({ file: path.basename(filePath), reason })
    }
  }

  return {
    success: true,
    kbId: targetKbId,
    imported,
    failed,
    skippedImages: ctx.skippedImages
  }
}
