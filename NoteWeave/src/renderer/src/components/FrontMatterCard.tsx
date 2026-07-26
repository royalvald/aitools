import { parseFrontMatter } from '../lib/front-matter'

// REQ-103：以只读卡片形式展示 Markdown 顶部的 YAML Front Matter。
// 编辑由源码模式直接修改原文完成；此处仅展示，避免破坏节点结构。

interface FrontMatterCardProps {
  content: string
}

export function FrontMatterCard({ content }: FrontMatterCardProps) {
  const { frontMatter, raw } = parseFrontMatter(content)
  if (!frontMatter || Object.keys(frontMatter).length === 0) return null
  return (
    <div className="front-matter-card" title="Front Matter（在源码模式下编辑顶部 YAML）">
      <div className="fm-title">Front Matter</div>
      <pre className="m-0 whitespace-pre-wrap break-words">{raw.replace(/^---\n?/, '').replace(/\n?---\n?$/, '').trim()}</pre>
    </div>
  )
}
