import type { DocMention } from '../types'

// REQ-202 @提及解析与构造（前端工具函数）。
// 提及语法：[[type:id|标题]]（type ∈ note / kbDoc）。

const MENTION_RE = /\[\[(note|kbDoc):([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g

// 解析文本中的全部提及（去重）。
export function parseMentions(text: string): DocMention[] {
  if (!text) return []
  const out: DocMention[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  MENTION_RE.lastIndex = 0
  while ((m = MENTION_RE.exec(text))) {
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: m[1] as 'note' | 'kbDoc', id: m[2], title: m[3] })
  }
  return out
}

// 构造一条提及原始文本。
export function buildMention(mention: DocMention): string {
  const title = mention.title ? `|${mention.title}` : ''
  return `[[${mention.kind}:${mention.id}${title}]]`
}

// 将文本中的提及语法替换为可读标题（用于摘要/展示）。
export function mentionsToReadable(text: string): string {
  if (!text) return ''
  return text.replace(MENTION_RE, (_, kind, id, title) => `@${title || `${kind}:${id}`}`)
}
