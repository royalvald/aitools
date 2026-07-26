// REQ-007 文档大纲：从 Markdown 内容提取 H1~H6 标题。
// 仅做轻量文本解析（支持 ATX 风格 # 标题与 Setext 风格下划线标题），
// 跳过代码块内的 # 行，避免误识别。

export interface TocItem {
  level: number // 1~6
  text: string
  /** 用于生成稳定的 DOM id（slug），供滚动定位 */
  id: string
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'heading'
  )
}

export function extractToc(markdown: string): TocItem[] {
  if (!markdown) return []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const items: TocItem[] = []
  let inFence = false
  let fenceMarker = ''
  const usedIds = new Map<string, number>()

  const push = (level: number, raw: string) => {
    // 去除行内 markdown 标记，保留纯文本
    const text = raw
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim()
    if (!text) return
    let id = slugify(text)
    const count = usedIds.get(id) ?? 0
    usedIds.set(id, count + 1)
    if (count > 0) id = `${id}-${count}`
    items.push({ level, text, id })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[2][0]
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
        fenceMarker = ''
      }
      continue
    }
    if (inFence) continue

    // ATX 标题
    const atx = line.match(/^(#{1,6})\s+(.*?)(?:\s+#{1,6})?$/)
    if (atx) {
      push(atx[1].length, atx[2])
      continue
    }
    // Setext 标题：下一行为 === 或 ---
    const next = lines[i + 1]
    if (next && /^\s*$/.test(line) === false) {
      if (/^=+\s*$/.test(next)) {
        push(1, line.trim())
        i++
        continue
      }
      if (/^-+\s*$/.test(next)) {
        push(2, line.trim())
        i++
        continue
      }
    }
  }
  return items
}
