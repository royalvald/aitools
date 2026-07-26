import { useEffect, useState } from 'react'
import { ChevronRight, List } from 'lucide-react'
import { extractToc, type TocItem } from '../lib/toc'
import { cn } from '../lib/utils'

interface DocOutlineProps {
  markdown: string
  /** 用于在文档容器内查找标题元素并滚动。父级提供容器 ref 查询函数。 */
  containerRef: React.RefObject<HTMLElement | null>
  /** 嵌入统一右侧栏（tab 容器）时：占满容器宽度、无边框与自有标题栏 */
  embedded?: boolean
}

// REQ-007 文档大纲：列出 H1~H6，点击滚动到对应标题，滚动时高亮当前章节。
export function DocOutline({ markdown, containerRef, embedded }: DocOutlineProps) {
  const toc = extractToc(markdown)
  const [activeIdx, setActiveIdx] = useState(0)

  // 找到容器内所有标题元素（按出现顺序）。
  // 排除带 data-doc-title 的文档大标题（语雀式页头标题，不属于正文大纲）。
  const getHeadings = (): HTMLElement[] => {
    const root = containerRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter(
      (el) => !(el as HTMLElement).hasAttribute('data-doc-title')
    ) as HTMLElement[]
  }

  // 滚动时根据标题位置确定当前章节。
  useEffect(() => {
    const root = containerRef.current
    if (!root || toc.length === 0) return
    const onScroll = () => {
      const headings = getHeadings()
      if (headings.length === 0) return
      const scrollTop = root.scrollTop
      let current = 0
      for (let i = 0; i < headings.length; i++) {
        // 相对容器顶部的位置（考虑标题自身高度偏移）
        const top = headings[i].offsetTop
        if (top - 40 <= scrollTop) {
          current = i
        } else {
          break
        }
      }
      setActiveIdx(current)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [containerRef, toc.length])

  const handleSelect = (idx: number) => {
    const headings = getHeadings()
    const target = headings[idx]
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveIdx(idx)
    }
  }

  if (toc.length === 0) return null

  return (
    <div
      className={
        embedded
          ? 'flex h-full w-full flex-col bg-[var(--color-surface)]'
          : 'flex h-full w-60 flex-shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface-2)]'
      }
    >
      {!embedded && (
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-4 py-2.5 text-xs font-semibold text-[var(--color-muted-foreground)]">
          <List className="h-3.5 w-3.5" />
          大纲
          <span className="ml-auto">{toc.length}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {toc.map((item, idx) => (
            <button
              key={idx}
              onClick={() => handleSelect(idx)}
              className={cn(
                'flex w-full items-start gap-1 px-3 py-1 text-left text-[13px] leading-snug transition-colors',
                activeIdx === idx
                  ? 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)] hover:text-[var(--color-foreground)]'
              )}
              style={{ paddingLeft: 12 + (item.level - 1) * 14 }}
              title={item.text}
            >
              <ChevronRight
                className={cn(
                  'mt-0.5 h-3 w-3 flex-shrink-0',
                  activeIdx === idx ? 'text-[var(--color-primary)]' : 'opacity-40'
                )}
              />
              <span className="truncate">{item.text}</span>
            </button>
          ))}
      </div>
    </div>
  )
}
