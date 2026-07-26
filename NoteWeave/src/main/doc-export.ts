import { BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { getKbDoc, getNote, getAssetsDir, listAnnotations, resolveThemeCss } from './store'
import { exportWithPandoc } from './pandoc'
import type { KnowledgeBaseDoc, Note } from '../shared/types'

// REQ-008 单文档导出：PDF / HTML / Word。
//
// 设计权衡（无新依赖、纯本地）：
// - Markdown → HTML 使用内置的轻量转换器（覆盖标题/粗斜体/行内与块级代码/列表/
//   引用/链接/表格/分割线/图片占位）。LaTeX 与 Mermaid 在 HTML 中以原始源码块保留
//   （PDF 渲染依赖浏览器，Mermaid 暂以代码块呈现）。
// - PDF：通过离屏 BrowserWindow 加载导出 HTML，等加载完成后 printToPDF。
// - HTML：内联样式，生成独立可分享文件。
// - Word：导出为带 Word 兼容 meta 的 HTML（.doc），Word/WPS 可打开编辑（html-to-docx 需
//   额外依赖，本地优先策略下改用兼容 HTML 方案，标注为「基础样式」）。

interface ExportTargetDoc {
  name: string
  content: string
  annotations?: { text: string; content: string }[]
}

async function resolveTarget(
  target: { kind: 'note'; noteId: string } | { kind: 'kbDoc'; kbId: string; docId: string },
  options?: { includeAnnotations?: boolean }
): Promise<ExportTargetDoc | null> {
  if (target.kind === 'note') {
    const note = (await getNote(target.noteId)) as Note | null
    if (!note) return null
    return { name: note.title || '无标题', content: note.content }
  }
  const doc = (await getKbDoc(target.kbId, target.docId)) as KnowledgeBaseDoc | null
  if (!doc) return null
  const result: ExportTargetDoc = { name: doc.name || '未命名文档', content: doc.content }
  // REQ-008：当请求包含批注时，读取该文档的批注并填充到导出目标。
  if (options?.includeAnnotations) {
    try {
      const anns = await listAnnotations(target.kbId, target.docId)
      if (anns.length > 0) {
        result.annotations = anns.map((a) => ({ text: a.text, content: a.content }))
      }
    } catch {
      // 批注读取失败时不阻断导出，仅不附加批注。
    }
  }
  return result
}

// REQ-004 导出端：把 noteweave-asset:// 引用替换为 base64 data URI，使导出的独立文件
// 能离线显示图片。非图片（附件）保留链接但改为 file-relative 文本提示。
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

async function embedAssets(markdown: string): Promise<string> {
  const re = /noteweave-asset:\/\/\/?([^)\s"']+)/g
  const matches = Array.from(markdown.matchAll(re))
  if (matches.length === 0) return markdown
  const replacements = new Map<string, string>()
  for (const m of matches) {
    const rawUrl = m[0]
    if (replacements.has(rawUrl)) continue
    let rel = decodeURIComponent(m[1])
    if (rel.startsWith('assets/')) rel = rel.slice('assets/'.length)
    const abs = path.resolve(getAssetsDir(), rel)
    const ext = (path.extname(abs).slice(1) || '').toLowerCase()
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream'
    try {
      const buf = await fs.readFile(abs)
      const b64 = buf.toString('base64')
      replacements.set(rawUrl, `data:${mime};base64,${b64}`)
    } catch {
      // 文件缺失：保留原协议链接（导出后无法显示，但不破坏流程）
      replacements.set(rawUrl, rawUrl)
    }
  }
  return markdown.replace(re, (url) => replacements.get(url) ?? url)
}

// 转义 HTML 特殊字符（用于纯文本内容）。
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 内联格式：粗体、斜体、行内代码、链接、图片、行内公式占位。
function renderInline(text: string): string {
  let out = esc(text)
  // 图片 ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
  // 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // 行内代码 `code`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 粗体 **text** 或 __text__
  out = out.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  // 斜体 *text* 或 _text_
  out = out.replace(/(^|[^*])\*([^\*]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>')
  // 行内公式 $...$ → 保留原文，便于复制；外层用 .katex 类
  out = out.replace(/\$([^$]+)\$/g, '<span class="math-inline">$1</span>')
  return out
}

// 轻量 Markdown → HTML 块级转换。
function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const html: string[] = []
  let i = 0
  let inList: 'ul' | 'ol' | null = null
  let inTaskList = false

  const closeList = () => {
    if (inList) {
      html.push(`</${inList}>`)
      inList = null
      inTaskList = false
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // 块级代码 / mermaid / 块级公式围栏
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      closeList()
      const lang = fence[1] || ''
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // skip closing fence
      const code = buf.join('\n')
      if (lang.toLowerCase() === 'mermaid') {
        // Mermaid 以代码块形式保留（导出端不联网渲染）
        html.push(
          `<div class="mermaid-source"><pre><code>${esc(code)}</code></pre></div>`
        )
      } else {
        html.push(
          `<pre><code class="language-${esc(lang)}">${esc(code)}</code></pre>`
        )
      }
      continue
    }

    // 块级公式 $$ ... $$
    if (/^\$\$\s*$/.test(line.trim())) {
      closeList()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\$\$\s*$/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++
      html.push(`<div class="math-block">${esc(buf.join('\n'))}</div>`)
      continue
    }

    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      i++
      continue
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      html.push('<hr />')
      i++
      continue
    }

    // 引用
    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeList()
      const buf: string[] = [quote[1]]
      i++
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${renderInline(buf.join(' '))}</blockquote>`)
      continue
    }

    // 表格（简单的 | a | b |）
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
      closeList()
      const header = line.split('|').slice(1, -1).map((c) => c.trim())
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()))
        i++
      }
      html.push('<table><thead><tr>')
      header.forEach((h) => html.push(`<th>${renderInline(h)}</th>`))
      html.push('</tr></thead><tbody>')
      rows.forEach((r) => {
        html.push('<tr>')
        r.forEach((c) => html.push(`<td>${renderInline(c)}</td>`))
        html.push('</tr>')
      })
      html.push('</tbody></table>')
      continue
    }

    // 任务列表项 - [ ] / - [x]
    const task = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      if (!inTaskList) {
        closeList()
        inTaskList = true
        inList = 'ul'
        html.push('<ul class="task-list">')
      }
      const checked = task[1].toLowerCase() === 'x'
      html.push(
        `<li><input type="checkbox" disabled${checked ? ' checked' : ''} /> ${renderInline(task[2])}</li>`
      )
      i++
      continue
    }

    // 无序列表
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) {
      if (inList !== 'ul' || inTaskList) {
        closeList()
        inList = 'ul'
        html.push('<ul>')
      }
      html.push(`<li>${renderInline(ul[1])}</li>`)
      i++
      continue
    }

    // 有序列表
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) {
      if (inList !== 'ol' || inTaskList) {
        closeList()
        inList = 'ol'
        html.push('<ol>')
      }
      html.push(`<li>${renderInline(ol[1])}</li>`)
      i++
      continue
    }

    // 空行
    if (line.trim() === '') {
      closeList()
      i++
      continue
    }

    // 普通段落
    closeList()
    const buf = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^>/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    html.push(`<p>${renderInline(buf.join(' '))}</p>`)
  }
  closeList()
  return html.join('\n')
}

const EXPORT_CSS = `
  body { font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; line-height: 1.7; color: #1e293b; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
  h1,h2,h3,h4 { font-weight: 600; line-height: 1.3; }
  h1 { font-size: 1.7rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.3rem; }
  h2 { font-size: 1.4rem; }
  h3 { font-size: 1.15rem; }
  code { font-family: ui-monospace, Consolas, monospace; background: #f1f5f9; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
  pre { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 0.85rem; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #2563eb; background: #f8fafc; margin: 0 0 0.75rem; padding: 0.4rem 1rem; color: #475569; border-radius: 0 4px 4px 0; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 0.75rem; }
  th, td { border: 1px solid #e2e8f0; padding: 0.45rem 0.7rem; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.2rem 0; }
  .task-list { list-style: none; padding-left: 0; }
  .task-list li { list-style: none; }
  .math-inline, .math-block { font-family: "Times New Roman", serif; font-style: italic; }
  .math-block { text-align: center; margin: 0.75rem 0; font-size: 1.05rem; }
  .annotation-list { margin-top: 2rem; border-top: 2px solid #e2e8f0; padding-top: 1rem; }
  .annotation-list h2 { font-size: 1.1rem; }
  .annotation-item { margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: #fffbeb; border-left: 3px solid #f59e0b; border-radius: 0 4px 4px 0; }
  .annotation-quote { color: #b45309; font-size: 0.85rem; margin-bottom: 0.2rem; }
`

function buildFullHtml(doc: ExportTargetDoc, title: string, extraCss = ''): string {
  const bodyHtml = markdownToHtml(doc.content)
  let annotationsHtml = ''
  if (doc.annotations && doc.annotations.length) {
    annotationsHtml =
      '<section class="annotation-list"><h2>批注</h2>' +
      doc.annotations
        .map(
          (a) =>
            `<div class="annotation-item"><div class="annotation-quote">“${esc(a.text)}”</div><div>${renderInline(a.content)}</div></div>`
        )
        .join('') +
      '</section>'
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>${EXPORT_CSS}</style>
${extraCss ? `<style>${extraCss}</style>` : ''}
</head>
<body>
<h1>${esc(title)}</h1>
${bodyHtml}
${annotationsHtml}
</body>
</html>`
}

// Word 兼容 HTML：加 Office 命名空间 meta，保存为 .doc 可被 Word/WPS 打开编辑。
function buildWordHtml(doc: ExportTargetDoc, title: string, extraCss = ''): string {
  const html = buildFullHtml(doc, title, extraCss)
  return `MIME-Version: 1.0
Content-Type: text/html; charset="utf-8"
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${EXPORT_CSS}</style></head>
${html.replace(/^<!DOCTYPE html>[\s\S]*?<body>/, '<body>')}
</html>`
}

async function pickSavePath(
  defaultName: string,
  filters: Electron.FileFilter[]
): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: '导出文档',
    defaultPath: defaultName,
    filters
  })
  if (result.canceled || !result.filePath) return null
  return result.filePath
}

async function exportHtml(
  doc: ExportTargetDoc,
  extraCss = ''
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.html`, [
    { name: 'HTML', extensions: ['html'] }
  ])
  if (!filePath) return { success: false, filePath: null }
  try {
    await fs.writeFile(filePath, buildFullHtml(doc, doc.name, extraCss), 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

async function exportWord(
  doc: ExportTargetDoc,
  extraCss = ''
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.doc`, [
    { name: 'Word (HTML)', extensions: ['doc'] }
  ])
  if (!filePath) return { success: false, filePath: null }
  try {
    await fs.writeFile(filePath, buildWordHtml(doc, doc.name, extraCss), 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

async function exportPdf(
  doc: ExportTargetDoc,
  extraCss = ''
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.pdf`, [
    { name: 'PDF', extensions: ['pdf'] }
  ])
  if (!filePath) return { success: false, filePath: null }
  const win = new BrowserWindow({
    width: 900,
    height: 1200,
    show: false,
    webPreferences: { offscreen: false }
  })
  try {
    const html = buildFullHtml(doc, doc.name, extraCss)
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    // 等待图片/字体加载
    await new Promise((resolve) => setTimeout(resolve, 600))
    const pdfData = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    })
    await fs.writeFile(filePath, pdfData)
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  } finally {
    win.destroy()
  }
}

export async function exportDoc(
  target: { kind: 'note'; noteId: string } | { kind: 'kbDoc'; kbId: string; docId: string },
  format: 'pdf' | 'html' | 'word' | 'epub' | 'latex' | 'rtf' | 'txt' | 'opml' | 'markdown',
  options?: { includeAnnotations?: boolean; themeName?: string; usePandoc?: boolean }
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const doc = await resolveTarget(target, options)
  if (!doc) return { success: false, filePath: null, error: '文档不存在' }
  // REQ-004：导出时将图片资源嵌入为 base64，保证独立文件可离线显示（PDF/HTML/EPUB 等）。
  const embedded: ExportTargetDoc = { ...doc, content: await embedAssets(doc.content) }
  // REQ-111：解析自定义主题 CSS（内置主题返回空串）
  let extraCss = ''
  if (options?.themeName) {
    const css = await resolveThemeCss(options.themeName)
    extraCss = css ?? ''
  }
  // REQ-119：使用 Pandoc 导出（委托系统 Pandoc CLI）
  if (options?.usePandoc && format !== 'opml' && format !== 'markdown') {
    const filters = ['pdf', 'html', 'word', 'epub', 'latex', 'rtf', 'txt']
    if (filters.includes(format)) {
      const ext = format === 'word' ? 'docx' : format
      const filePath = await pickSavePath(`${doc.name}.${ext}`, [
        { name: ext.toUpperCase(), extensions: [ext] }
      ])
      if (!filePath) return { success: false, filePath: null }
      const r = await exportWithPandoc(doc.content, filePath)
      return { success: r.success, filePath: r.success ? filePath : null, error: r.error }
    }
  }
  switch (format) {
    case 'pdf':
      return exportPdf(embedded, extraCss)
    case 'html':
      return exportHtml(embedded, extraCss)
    case 'word':
      return exportWord(embedded, extraCss)
    case 'markdown':
      return exportMarkdown(doc)
    case 'txt':
      return exportTxt(doc)
    case 'rtf':
      return exportRtf(embedded, doc.name)
    case 'opml':
      return exportOpml(doc)
    case 'latex':
      return exportLatex(doc)
    case 'epub':
      return exportEpub(embedded, doc.name)
    default:
      return { success: false, filePath: null, error: '不支持的导出格式' }
  }
}

// REQ-112：直接保存 Markdown 原文（含 Front Matter）。
async function exportMarkdown(
  doc: ExportTargetDoc
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.md`, [{ name: 'Markdown', extensions: ['md'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    await fs.writeFile(filePath, doc.content, 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

// REQ-112：纯文本导出（去除 Markdown 标记）。
function stripToPlain(md: string): string {
  return md
    .replace(/^---[\s\S]*?---\s*/, '') // front matter
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~#>|]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function exportTxt(
  doc: ExportTargetDoc
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.txt`, [{ name: '文本', extensions: ['txt'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    await fs.writeFile(filePath, stripToPlain(doc.content), 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

// REQ-112：RTF 导出（轻量，保留段落与粗斜体）。
async function exportRtf(
  doc: ExportTargetDoc,
  title: string
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${title}.rtf`, [{ name: 'RTF', extensions: ['rtf'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    const lines = stripToPlain(doc.content).split('\n')
    const paras = lines
      .map((l) => `{\\par ${l.replace(/[\\{}]/g, (c) => '\\' + c)}}`)
      .join('\n')
    const rtf = `{\\rtf1\\ansi\\ansicpg936\\deff0{\\fonttbl{\\f0 SimSun;}}\\fs24 ${title}\\par\\par ${paras}}`
    await fs.writeFile(filePath, rtf, 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

// REQ-112：OPML 大纲导出（按标题层级展开）。
async function exportOpml(
  doc: ExportTargetDoc
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.opml`, [{ name: 'OPML', extensions: ['opml'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    const lines = doc.content.replace(/^---[\s\S]*?---\s*/, '').split('\n')
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
    let body = ''
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)$/)
      if (m) {
        body += `${'  '.repeat(m[1].length)}<outline text="${esc(m[2])}" />\n`
      }
    }
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
<head><title>${esc(doc.name)}</title></head>
<body>
${body}</body>
</opml>`
    await fs.writeFile(filePath, opml, 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

// REQ-112：LaTeX 导出（标题→section，代码→lstlisting，公式保留 $，图→figure）。
async function exportLatex(
  doc: ExportTargetDoc
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${doc.name}.tex`, [{ name: 'LaTeX', extensions: ['tex'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    const lines = doc.content.replace(/^---[\s\S]*?---\s*/, '').split('\n')
    const out: string[] = []
    out.push('\\documentclass{article}')
    out.push('\\usepackage[UTF8]{ctex}')
    out.push('\\usepackage{graphicx}')
    out.push('\\usepackage{listings}')
    out.push('\\usepackage{amsmath,amssymb}')
    out.push('\\title{' + doc.name.replace(/[&_{}%$#^~\\]/g, '\\$&') + '}')
    out.push('\\begin{document}')
    out.push('\\maketitle')
    let inCode = false
    let codeBuf: string[] = []
    for (const line of lines) {
      const fence = line.match(/^```(\w*)/)
      if (fence) {
        if (!inCode) {
          inCode = true
          codeBuf = []
        } else {
          out.push('\\begin{lstlisting}')
          out.push(...codeBuf)
          out.push('\\end{lstlisting}')
          inCode = false
        }
        continue
      }
      if (inCode) {
        codeBuf.push(line)
        continue
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/)
      if (h) {
        const lvl = h[1].length
        const cmd = lvl === 1 ? 'section' : lvl === 2 ? 'subsection' : 'subsubsection'
        out.push(`\\${cmd}{${h[2].replace(/[&_{}%$#^~\\]/g, '\\$&')}}`)
        continue
      }
      const img = line.match(/!\[[^\]]*\]\(([^)]+)\)/)
      if (img) {
        out.push(`\\begin{figure}[h]\\centering\\includegraphics[width=0.7\\textwidth]{${img[1]}}\\end{figure}`)
        continue
      }
      if (line.trim()) {
        out.push(line.replace(/[&_{}%$#^~\\](?!\w)/g, (c) => '\\$&'))
      }
    }
    out.push('\\end{document}')
    await fs.writeFile(filePath, out.join('\n'), 'utf-8')
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}

// REQ-112：EPUB 导出（用 jszip 手写最小 EPUB3）。
async function exportEpub(
  doc: ExportTargetDoc,
  title: string
): Promise<{ success: boolean; filePath: string | null; error?: string }> {
  const filePath = await pickSavePath(`${title}.epub`, [{ name: 'EPUB', extensions: ['epub'] }])
  if (!filePath) return { success: false, filePath: null }
  try {
    const JSZip = (await import('jszip')).default
    const zip = new JSZip()
    const bodyHtml = markdownToHtml(doc.content)
    const uid = 'noteweave-' + Date.now()
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
    zip.folder('META-INF')!.file('container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
    zip.folder('OEBPS')!.file('content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
<dc:language>zh-CN</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="ch1"/></spine>
</package>`)
    zip.folder('OEBPS')!.file(
      'nav.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(title)}</title></head><body><nav epub:type="toc"><ol><li><a href="chapter1.xhtml">${esc(title)}</a></li></ol></nav></body></html>`
    )
    zip.folder('OEBPS')!.file(
      'chapter1.xhtml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(title)}</title><style>body{font-family:sans-serif;line-height:1.7}img{max-width:100%}</style></head><body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`
    )
    const buf = await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' })
    await fs.writeFile(filePath, buf)
    return { success: true, filePath }
  } catch (e) {
    return { success: false, filePath: null, error: (e as Error).message }
  }
}
