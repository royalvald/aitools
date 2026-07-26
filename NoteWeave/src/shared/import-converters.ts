// REQ-209 导入外部文件的纯转换函数（无 Electron / 依赖注入，便于单测）。

// 安全化文件名作为文档标题
export function safeDocName(fileName: string): string {
  const base = fileName.includes('/') || fileName.includes('\\')
    ? fileName.split(/[\\/]/).pop() ?? fileName
    : fileName
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? base.slice(0, dot) : base
  return name.trim() || '未命名文档'
}

// 去掉 Notion 导出文件名末尾的 32 位 UUID（形如 "标题 abc123def456..."）
export function stripNotionUuid(title: string): string {
  return title.replace(/\s+[a-z0-9]{32}$/i, '').trim() || title
}

// 从 Notion Markdown 内容中提取图片引用的文件名（URL 解码最后一段路径）
export function extractNotionImageNames(markdown: string): string[] {
  const re = /!\[[^\]]*\]\(([^)]+)\)/g
  const names: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(markdown))) {
    try {
      const decoded = decodeURIComponent(m[1])
      const base = decoded.split(/[\\/]/).pop()
      if (base) names.push(base)
    } catch {
      // ignore malformed url
    }
  }
  return names
}

// 极简 HTML → 纯文本兜底（无 turndown 可用时）
export function htmlFallbackToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 判断文件扩展名是否为可导入的文档
export function isImportableExt(ext: string): boolean {
  const e = ext.toLowerCase().replace(/^\./, '')
  return ['docx', 'html', 'htm', 'md', 'markdown', 'txt'].includes(e)
}
