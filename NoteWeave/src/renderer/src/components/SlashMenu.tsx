import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Network,
  Quote,
  Sigma,
  Subscript,
  Superscript,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Workflow,
  Footprints
} from 'lucide-react'
import { cn } from '../lib/utils'

/** 斜杠命令类型（命令的具体执行由父组件 milkdown-slash 在选中后调用 Milkdown 命令完成）。 */
export interface SlashCommandItem {
  id: string
  label: string
  /** 关键词，用于过滤匹配 */
  keywords: string[]
  icon: typeof Heading1
  /** 在 milkdown-slash 中绑定的执行器名 */
  action: SlashCommandAction
}

/** 所有支持的命令动作。milkdown-slash 据此分发到对应 Milkdown 命令。 */
export type SlashCommandAction =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'codeBlock'
  | 'hr'
  | 'table'
  | 'math'
  | 'mermaid'
  | 'plantuml'
  | 'graphviz'
  | 'footnote'
  | 'highlight'
  | 'underline'
  | 'superscript'
  | 'subscript'

const COMMANDS: SlashCommandItem[] = [
  { id: 'h1', label: '一级标题', keywords: ['标题', 'h1', 'heading'], icon: Heading1, action: 'heading1' },
  { id: 'h2', label: '二级标题', keywords: ['标题', 'h2', 'heading'], icon: Heading2, action: 'heading2' },
  { id: 'h3', label: '三级标题', keywords: ['标题', 'h3', 'heading'], icon: Heading3, action: 'heading3' },
  { id: 'bullet', label: '无序列表', keywords: ['列表', 'bullet', 'list', '无序'], icon: List, action: 'bulletList' },
  { id: 'ordered', label: '有序列表', keywords: ['列表', 'ordered', 'list', '有序'], icon: ListOrdered, action: 'orderedList' },
  { id: 'task', label: '待办列表', keywords: ['待办', '任务', 'task', 'todo', 'checkbox'], icon: ListTodo, action: 'taskList' },
  { id: 'quote', label: '引用', keywords: ['引用', 'quote', 'blockquote'], icon: Quote, action: 'quote' },
  { id: 'code', label: '代码块', keywords: ['代码', 'code', 'codeblock'], icon: Code2, action: 'codeBlock' },
  { id: 'hr', label: '分割线', keywords: ['分割线', 'hr', 'divider', 'line'], icon: Minus, action: 'hr' },
  { id: 'table', label: '表格', keywords: ['表格', 'table'], icon: TableIcon, action: 'table' },
  { id: 'math', label: '数学公式', keywords: ['公式', '数学', 'math', 'latex', 'katex'], icon: Sigma, action: 'math' },
  { id: 'mermaid', label: 'Mermaid 图表', keywords: ['图表', '流程图', 'mermaid', 'diagram'], icon: Workflow, action: 'mermaid' },
  { id: 'plantuml', label: 'PlantUML 图', keywords: ['plantuml', 'puml', '时序图', '类图'], icon: Network, action: 'plantuml' },
  { id: 'graphviz', label: 'Graphviz 图', keywords: ['graphviz', 'dot', '关系图'], icon: Network, action: 'graphviz' },
  { id: 'footnote', label: '脚注', keywords: ['脚注', 'footnote', '引用'], icon: Footprints, action: 'footnote' },
  { id: 'highlight', label: '高亮标记', keywords: ['高亮', 'highlight', 'mark'], icon: Highlighter, action: 'highlight' },
  { id: 'underline', label: '下划线', keywords: ['下划线', 'underline'], icon: UnderlineIcon, action: 'underline' },
  { id: 'superscript', label: '上标', keywords: ['上标', 'superscript', 'sup'], icon: Superscript, action: 'superscript' },
  { id: 'subscript', label: '下标', keywords: ['下标', 'subscript', 'sub'], icon: Subscript, action: 'subscript' }
]

interface SlashMenuProps {
  filter: string
  onSelect: (action: SlashCommandAction) => void
  onClose: () => void
}

/**
 * 斜杠命令菜单 UI（REQ-001）。
 *
 * 浮层定位由 SlashProvider（floating-ui）负责，本组件只负责列表渲染与过滤。
 * 键盘：↑/↓ 选择，Enter 确定，Esc 关闭（Esc 由父级监听 document keydown 处理，
 * 因 SlashProvider 的 content 默认不抢编辑区焦点）。
 */
export function SlashMenu({ filter, onSelect, onClose }: SlashMenuProps) {
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return COMMANDS
    return COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.keywords.some((k) => k.toLowerCase().includes(q))
    )
  }, [filter])

  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setActiveIndex(0)
  }, [filter])

  // 键盘导航：监听捕获阶段，避免编辑器消费
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length))
      } else if (e.key === 'Enter') {
        if (filtered.length > 0) {
          e.preventDefault()
          onSelect(filtered[activeIndex].action)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    // 用 capture 让本组件先于 ProseMirror 拦截
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [filtered, activeIndex, onSelect, onClose])

  // 滚动激活项进入视口
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (filtered.length === 0) {
    return (
      <div className="slash-menu">
        <div className="slash-menu-empty">没有匹配的命令</div>
      </div>
    )
  }

  return (
    <div className="slash-menu" ref={listRef}>
      <div className="slash-menu-title">插入</div>
      <div className="slash-menu-list">
        {filtered.map((c, i) => {
          const Icon = c.icon
          return (
            <button
              key={c.id}
              type="button"
              data-index={i}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => onSelect(c.action)}
              className={cn(
                'slash-menu-item',
                i === activeIndex && 'slash-menu-item-active'
              )}
            >
              <Icon className="slash-menu-item-icon" />
              <span>{c.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
