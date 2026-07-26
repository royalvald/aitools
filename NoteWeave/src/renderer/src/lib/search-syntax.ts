import type { SearchHitType } from '../types'

// REQ-204 搜索快捷语法解析：tag:xxx / kb:xxx / type:note|doc|todo|annotation|comment
// 返回剩余关键词与解析出的筛选项。
export function parseQuickSyntax(raw: string): {
  keyword: string
  tags: string[]
  kbIds: string[]
  forcedTypes: SearchHitType[]
} {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const tags: string[] = []
  const kbIds: string[] = []
  const forcedTypes: SearchHitType[] = []
  const rest: string[] = []
  for (const tok of tokens) {
    const lower = tok.toLowerCase()
    if (lower.startsWith('tag:')) {
      const v = tok.slice(4)
      if (v) tags.push(v)
    } else if (lower.startsWith('kb:')) {
      const v = tok.slice(3)
      if (v) kbIds.push(v)
    } else if (lower.startsWith('type:')) {
      const v = tok.slice(5).toLowerCase()
      const map: Record<string, SearchHitType> = {
        note: 'note',
        doc: 'kbDoc',
        kbdoc: 'kbDoc',
        todo: 'todo',
        annotation: 'annotation',
        comment: 'comment'
      }
      if (map[v]) forcedTypes.push(map[v])
    } else {
      rest.push(tok)
    }
  }
  return { keyword: rest.join(' '), tags, kbIds, forcedTypes }
}
