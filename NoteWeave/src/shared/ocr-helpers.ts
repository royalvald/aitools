// REQ-205 OCR 纯函数（无 Electron 依赖，便于单测）。

// asset 相对路径 → OCR 缓存键（去扩展名 + 非法字符替换 + 长度截断）
export function ocrCacheKey(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/\.[^./]+$/, '')
  return norm.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(-120) || 'root'
}

// asset 相对路径 → noteweave-asset:// URL
export function relToAssetUrl(rel: string): string {
  const norm = rel.replace(/\\/g, '/')
  return `noteweave-asset:///${norm}`
}

// 从 OCR 文本中判断是否命中查询（不区分大小写）
export function ocrTextMatches(text: string, query: string): boolean {
  if (!text || !query) return false
  return text.toLowerCase().includes(query.toLowerCase())
}
