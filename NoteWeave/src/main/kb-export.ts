import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import type { KnowledgeBaseDocSummary } from '../shared/types'
import {
  getKnowledgeBase,
  listKbDocs,
  getKbDoc,
  listAnnotations,
  listComments,
  listHistory,
  getAssetsDir
} from './store'

// REQ-210 批量导出整个知识库。
// 支持三种格式：Markdown 文件夹（保持层级）/ HTML 站点（含索引页与导航）/ ZIP（全部资源）。
// 可选包含批注、评论、版本历史元数据。

export interface KbExportOptions {
  format: 'markdown-folder' | 'html-site' | 'zip'
  includeAnnotations?: boolean
  includeComments?: boolean
  includeHistory?: boolean
}

export interface KbExportResult {
  success: boolean
  outputPath: string | null
  docCount: number
  error?: string
}

// 非法文件名字符转义（用于生成磁盘文件名）
function safeFileName(name: string, fallback = '未命名文档'): string {
  const cleaned = (name || fallback).replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned || fallback
}

// 收集某文档引用的全部 asset 相对路径（用于复制资源到导出目录）
function collectAssetRels(content: string): string[] {
  const re = /noteweave-asset:\/\/\/?([^)\s"']+)/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    let rel = decodeURIComponent(m[1])
    if (rel.startsWith('assets/')) rel = rel.slice('assets/'.length)
    out.push(rel.replace(/\\/g, '/'))
  }
  return out
}

// 把 markdown 中的 noteweave-asset:// 引用替换为相对路径（指向 ./assets/...）
function rewriteAssetUrlsToRelative(markdown: string, assetsPrefix: string): string {
  const re = /noteweave-asset:\/\/\/?([^)\s"']+)/g
  return markdown.replace(re, (full, relRaw) => {
    let rel = decodeURIComponent(relRaw)
    if (rel.startsWith('assets/')) rel = rel.slice('assets/'.length)
    return `${assetsPrefix}/${rel.replace(/\\/g, '/')}`
  })
}

// 复制文档引用的资源到目标 assets 目录，返回实际复制的文件列表
async function copyReferencedAssets(
  contents: { docId: string; content: string }[],
  destAssetsDir: string
): Promise<{ copied: number; missing: string[] }> {
  const relSet = new Set<string>()
  for (const c of contents) {
    for (const rel of collectAssetRels(c.content)) relSet.add(rel)
  }
  let copied = 0
  const missing: string[] = []
  for (const rel of relSet) {
    const src = path.resolve(getAssetsDir(), rel)
    const dest = path.join(destAssetsDir, rel)
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await fs.copyFile(src, dest)
      copied++
    } catch {
      missing.push(rel)
    }
  }
  return { copied, missing }
}

// 构建文档在导出树中的相对路径（按 parentId 层级），返回 { path, depth }
function buildDocRelativePath(
  docs: KnowledgeBaseDocSummary[],
  docId: string,
  name: string
): string {
  const byId = new Map(docs.map((d) => [d.id, d]))
  const segments: string[] = []
  let current = byId.get(docId)
  // 先压入自身名
  segments.unshift(safeFileName(name))
  // 向上追溯父节点
  const visited = new Set<string>()
  while (current?.parentId && !visited.has(current.id)) {
    visited.add(current.id)
    const parent = byId.get(current.parentId)
    if (!parent) break
    segments.unshift(safeFileName(parent.name))
    current = parent
  }
  return segments.join('/')
}

// 收集单个文档的可选元数据（批注/评论/历史），追加到 markdown 末尾
async function buildMetadataSection(
  kbId: string,
  doc: KnowledgeBaseDocSummary,
  options: KbExportOptions
): Promise<string> {
  const sections: string[] = []
  if (options.includeAnnotations) {
    try {
      const anns = await listAnnotations(kbId, doc.id)
      if (anns.length > 0) {
        sections.push(
          '## 批注\n' +
            anns
              .map((a) => `- **原文片段**：「${a.text}」\n  - ${a.content}`)
              .join('\n')
        )
      }
    } catch {
      // ignore
    }
  }
  if (options.includeComments) {
    try {
      const comments = await listComments(kbId, doc.id)
      if (comments.length > 0) {
        sections.push(
          '## 评论\n' +
            comments
              .map((c) => {
                const replies = (c.replies ?? []).map((r) => `  - ↳ ${r.content}`).join('\n')
                return `- **[${c.paragraphId}]** ${c.content}${replies ? '\n' + replies : ''}`
              })
              .join('\n')
        )
      }
    } catch {
      // ignore
    }
  }
  if (options.includeHistory) {
    try {
      const history = await listHistory('kbDoc', doc.id)
      if (history.length > 0) {
        sections.push(
          '## 版本历史\n' +
            history
              .slice(0, 20)
              .map((h) => `- ${h.savedAt}（${h.length} 字符）`)
              .join('\n')
        )
      }
    } catch {
      // ignore
    }
  }
  if (sections.length === 0) return ''
  return '\n\n---\n\n' + sections.join('\n\n')
}

// Markdown 文件夹导出
async function exportMarkdownFolder(
  kbId: string,
  kbName: string,
  docs: KnowledgeBaseDocSummary[],
  options: KbExportOptions,
  outDir: string
): Promise<KbExportResult> {
  const rootDir = path.join(outDir, safeFileName(kbName, '知识库'))
  await fs.mkdir(rootDir, { recursive: true })
  const assetsDir = path.join(rootDir, 'assets')
  const docContents: { docId: string; content: string }[] = []
  let count = 0

  // 第一遍：读取内容并写盘 .md
  for (const summary of docs) {
    const doc = await getKbDoc(kbId, summary.id)
    if (!doc) continue
    const meta = await buildMetadataSection(kbId, summary, options)
    const md = rewriteAssetUrlsToRelative(doc.content + meta, 'assets')
    docContents.push({ docId: summary.id, content: doc.content })
    const relPath = buildDocRelativePath(docs, summary.id, summary.name)
    const filePath = path.join(rootDir, `${relPath}.md`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, md, 'utf-8')
    count++
  }

  // 复制资源
  await copyReferencedAssets(docContents, assetsDir)

  // 写索引 README
  await fs.writeFile(
    path.join(rootDir, 'README.md'),
    `# ${kbName}\n\n共 ${count} 篇文档。\n`,
    'utf-8'
  )

  return { success: true, outputPath: rootDir, docCount: count }
}

// 极简 Markdown → HTML（用于站点预览，覆盖标题/段落/列表/代码/粗斜体/链接/图片）
function mdToHtml(md: string, assetPrefix: string): string {
  const lines = md.split('\n')
  const html: string[] = []
  let inCode = false
  let inList = false
  let inOl = false
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => `<img alt="${alt}" src="${url}" />`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  for (const raw of lines) {
    const line = raw
    if (line.trim().startsWith('```')) {
      if (inCode) {
        html.push('</code></pre>')
        inCode = false
      } else {
        if (inList) { html.push('</ul>'); inList = false }
        if (inOl) { html.push('</ol>'); inOl = false }
        html.push('<pre><code>')
        inCode = true
      }
      continue
    }
    if (inCode) {
      html.push(esc(line))
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      if (inList) { html.push('</ul>'); inList = false }
      if (inOl) { html.push('</ol>'); inOl = false }
      const level = h[1].length
      html.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { if (inOl) { html.push('</ol>'); inOl = false }; html.push('<ul>'); inList = true }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inOl) { if (inList) { html.push('</ul>'); inList = false }; html.push('<ol>'); inOl = true }
      html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`)
      continue
    }
    if (line.trim() === '') {
      if (inList) { html.push('</ul>'); inList = false }
      if (inOl) { html.push('</ol>'); inOl = false }
      html.push('')
      continue
    }
    if (inList) { html.push('</ul>'); inList = false }
    if (inOl) { html.push('</ol>'); inOl = false }
    html.push(`<p>${inline(line)}</p>`)
  }
  if (inCode) html.push('</code></pre>')
  if (inList) html.push('</ul>')
  if (inOl) html.push('</ol>')
  void assetPrefix
  return html.join('\n')
}

// HTML 站点导出（含索引页与导航）
async function exportHtmlSite(
  kbId: string,
  kbName: string,
  docs: KnowledgeBaseDocSummary[],
  options: KbExportOptions,
  outDir: string
): Promise<KbExportResult> {
  const rootDir = path.join(outDir, safeFileName(kbName, '知识库'))
  await fs.mkdir(rootDir, { recursive: true })
  const assetsDir = path.join(rootDir, 'assets')
  const docContents: { docId: string; content: string }[] = []
  let count = 0

  // 文档页面：扁平命名（避免目录嵌套导致导航复杂），文件名带序号保证唯一
  const pageFiles: { id: string; name: string; file: string }[] = []
  let idx = 0
  for (const summary of docs) {
    const doc = await getKbDoc(kbId, summary.id)
    if (!doc) continue
    const meta = await buildMetadataSection(kbId, summary, options)
    const md = rewriteAssetUrlsToRelative(doc.content + meta, 'assets')
    docContents.push({ docId: summary.id, content: doc.content })
    const file = `${String(idx).padStart(3, '0')}-${safeFileName(summary.name)}.html`
    pageFiles.push({ id: summary.id, name: summary.name, file })
    const body = mdToHtml(md, 'assets')
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(summary.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1e293b}img{max-width:100%}a{color:#2563eb}pre{background:#f1f5f9;padding:1rem;border-radius:6px;overflow:auto}code{background:#f1f5f9;padding:0 .2rem;border-radius:3px}pre code{background:none;padding:0}blockquote{border-left:3px solid #cbd5e1;margin:0;padding-left:1rem;color:#475569}.nav{margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid #e2e8f0}a.back{font-size:.875rem;color:#64748b}</style>
</head><body><div class="nav"><a class="back" href="index.html">← 返回索引</a></div><h1>${escHtml(summary.name)}</h1>${body}</body></html>`
    await fs.writeFile(path.join(rootDir, file), html, 'utf-8')
    idx++
    count++
  }

  await copyReferencedAssets(docContents, assetsDir)

  // 索引页
  const indexHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(kbName)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1e293b}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}li{margin:.3rem 0}</style>
</head><body><h1>${escHtml(kbName)}</h1><p>共 ${count} 篇文档。</p><ul>${pageFiles
    .map((p) => `<li><a href="${encodeURI(p.file)}">${escHtml(p.name)}</a></li>`)
    .join('\n')}</ul></body></html>`
  await fs.writeFile(path.join(rootDir, 'index.html'), indexHtml, 'utf-8')

  return { success: true, outputPath: rootDir, docCount: count }
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ZIP 导出（Markdown 文件夹打包 + 资源）
async function exportZip(
  kbId: string,
  kbName: string,
  docs: KnowledgeBaseDocSummary[],
  options: KbExportOptions,
  outDir: string
): Promise<KbExportResult> {
  const zip = new JSZip()
  const rootName = safeFileName(kbName, '知识库')
  const rootZip = zip.folder(rootName)!
  const assetsZip = rootZip.folder('assets')!
  const docContents: { docId: string; content: string }[] = []
  let count = 0

  for (const summary of docs) {
    const doc = await getKbDoc(kbId, summary.id)
    if (!doc) continue
    const meta = await buildMetadataSection(kbId, summary, options)
    const md = rewriteAssetUrlsToRelative(doc.content + meta, 'assets')
    docContents.push({ docId: summary.id, content: doc.content })
    const relPath = buildDocRelativePath(docs, summary.id, summary.name)
    rootZip.file(`${relPath}.md`, md)
    count++
  }

  // 复制资源到 ZIP
  const relSet = new Set<string>()
  for (const c of docContents) for (const rel of collectAssetRels(c.content)) relSet.add(rel)
  for (const rel of relSet) {
    const src = path.resolve(getAssetsDir(), rel)
    try {
      const buf = await fs.readFile(src)
      assetsZip.file(rel.replace(/\\/g, '/'), buf)
    } catch {
      // 缺失资源跳过
    }
  }

  rootZip.file('README.md', `# ${kbName}\n\n共 ${count} 篇文档。\n`)
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const zipPath = path.join(outDir, `${rootName}.zip`)
  await fs.writeFile(zipPath, buffer)
  return { success: true, outputPath: zipPath, docCount: count }
}

// 主入口
export async function exportKnowledgeBase(
  kbId: string,
  options: KbExportOptions
): Promise<KbExportResult> {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) {
    return { success: false, outputPath: null, docCount: 0, error: '没有可用的窗口' }
  }

  const kb = await getKnowledgeBase(kbId)
  if (!kb) {
    return { success: false, outputPath: null, docCount: 0, error: '知识库不存在' }
  }

  // 选择输出目录
  const { filePaths, canceled } = await dialog.showOpenDialog(window, {
    title: `导出知识库「${kb.name}」到文件夹`,
    properties: ['openDirectory']
  })
  if (canceled || !filePaths || filePaths.length === 0) {
    return { success: false, outputPath: null, docCount: 0 }
  }
  const outDir = filePaths[0]

  try {
    const docs = await listKbDocs(kbId)
    if (options.format === 'markdown-folder') {
      return await exportMarkdownFolder(kbId, kb.name, docs, options, outDir)
    } else if (options.format === 'html-site') {
      return await exportHtmlSite(kbId, kb.name, docs, options, outDir)
    } else if (options.format === 'zip') {
      return await exportZip(kbId, kb.name, docs, options, outDir)
    }
    return { success: false, outputPath: null, docCount: 0, error: '不支持的导出格式' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, outputPath: null, docCount: 0, error: `导出失败：${message}` }
  }
}

// 仅供测试导出
export const __test__ = { buildDocRelativePath, safeFileName, rewriteAssetUrlsToRelative, collectAssetRels }
