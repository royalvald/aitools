import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkFrontmatter from 'remark-frontmatter'
import remarkFootnotes from 'remark-footnotes'
import { rehypeExtraMarksPlugin } from '../lib/milkdown-extra-marks'
import { parseFrontMatter } from '../lib/front-matter'
import 'katex/dist/katex.min.css'
import type { Plugin } from 'unified'
import type { Root } from 'mdast'

// REQ-116 演示/幻灯片模式：按 H1/H2 切片，全屏展示，方向键翻页。

interface PresentationModeProps {
  content: string
  onClose: () => void
}

export function PresentationMode({ content, onClose }: PresentationModeProps) {
  const { body } = parseFrontMatter(content)
  const slides = useMemo(() => splitToSlides(body), [body])
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, slides.length - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [slides.length, onClose])

  if (slides.length === 0) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--color-foreground)] text-[var(--color-primary-foreground)]">
        <button className="absolute right-6 top-6" onClick={onClose}>
          <X />
        </button>
        <div>无内容</div>
      </div>
    )
  }

  const current = slides[idx]
  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#1e1e1e]">
      <button
        className="absolute right-6 top-6 z-10 text-[var(--color-primary-foreground)]/70 hover:text-[var(--color-primary-foreground)]"
        onClick={onClose}
        title="退出 (Esc)"
      >
        <X />
      </button>
      <div className="markdown-body flex flex-1 items-center justify-center overflow-auto px-[8vw] py-[6vh] text-[var(--color-primary-foreground)]">
        <div className="w-full max-w-4xl">
          <ReactMarkdown
            remarkPlugins={[
              remarkFrontmatter as Plugin<[], Root>,
              remarkGfm as Plugin<[], Root>,
              remarkMath as Plugin<[], Root>,
              remarkFootnotes as Plugin<[], Root>
            ]}
            rehypePlugins={[rehypeExtraMarksPlugin, rehypeKatex]}
          >
            {current}
          </ReactMarkdown>
        </div>
      </div>
      <div className="flex items-center justify-between px-8 py-4 text-[var(--color-primary-foreground)]/70">
        <button
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          disabled={idx === 0}
          className="disabled:opacity-30"
        >
          <ChevronLeft />
        </button>
        <span className="text-sm">{idx + 1} / {slides.length}</span>
        <button
          onClick={() => setIdx((i) => Math.min(i + 1, slides.length - 1))}
          disabled={idx === slides.length - 1}
          className="disabled:opacity-30"
        >
          <ChevronRight />
        </button>
      </div>
    </div>
  )
}

function splitToSlides(md: string): string[] {
  const lines = md.split('\n')
  const slides: string[] = []
  let current: string[] = []
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      if (current.some((l) => l.trim())) {
        slides.push(current.join('\n'))
      }
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current.some((l) => l.trim())) slides.push(current.join('\n'))
  return slides
}
