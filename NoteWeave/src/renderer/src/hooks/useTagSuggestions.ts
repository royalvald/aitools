import { useEffect, useState } from 'react'

// REQ-012 标签自动补全：聚合所有 Note 与所有 KB Doc 的 tags，去重排序后返回候选项。
// 供 TagInput 的 suggestions 使用，避免重复创建相似标签。
// 完全自包含：自行拉取 notes 与各知识库 docs；extraDeps 变化时重新聚合。
export function useTagSuggestions(extraDeps: unknown[] = []): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const collect = async () => {
      const set = new Set<string>()
      try {
        // 来自 Note 列表的 tags
        const notes = await window.electronAPI.listNotes()
        for (const n of notes) for (const t of n.tags ?? []) set.add(t)
      } catch {
        // 忽略
      }
      try {
        // 来自所有知识库文档的 tags
        const kbs = await window.electronAPI.listKnowledgeBases()
        await Promise.all(
          kbs.map(async (kb) => {
            try {
              const docs = await window.electronAPI.listKbDocs(kb.id)
              for (const d of docs) for (const t of d.tags ?? []) set.add(t)
            } catch {
              // 单个知识库失败不阻断
            }
          })
        )
      } catch {
        // 知识库列表读取失败时仅用 Note tags
      }
      if (!cancelled) {
        setSuggestions(Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
      }
    }
    void collect()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, extraDeps)

  return suggestions
}
