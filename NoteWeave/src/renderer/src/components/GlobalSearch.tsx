import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp,
  ChevronRight,
  Clock,
  FileText,
  ImageIcon,
  ListTodo,
  MessageSquareText,
  NotebookPen,
  Search,
  Star,
  X
} from 'lucide-react'
import { cn } from '../lib/utils'
import { parseQuickSyntax } from '../lib/search-syntax'
import { fuzzyMatch } from '../lib/fuzzy'
import type {
  FavoriteItem,
  KnowledgeBaseDocSummary,
  KnowledgeBaseSummary,
  NoteSummary,
  RecentItem,
  SearchHitType,
  SearchSort,
  SearchResult
} from '../types'

// REQ-005/108/109/204 三合一搜索浮层（VSCode 式）：
// - 搜索模式（Ctrl+Shift+F）：全文搜索 + 高级筛选，标题模糊匹配排在全文结果之前。
// - 快速打开（Ctrl+P）：空态显示「最近打开 + 收藏」，输入即标题模糊匹配。
// - 命令模式（Ctrl+Shift+P 或输入 > 开头）：命令列表模糊匹配 + Enter 执行。

export interface CommandItem {
  id: string
  label: string
  keywords?: string[]
  group?: string
  run: () => void
}

export type SearchPaletteMode = 'search' | 'quick' | 'command'

interface GlobalSearchProps {
  open: boolean
  mode: SearchPaletteMode
  onClose: () => void
  onSelect: (result: SearchResult) => void
  commands: CommandItem[]
  notes: NoteSummary[]
  kbs: KnowledgeBaseSummary[]
}

// 标题匹配/最近/收藏列表项（统一 Note 与 KB Doc）
interface TitleItem {
  id: string
  kind: 'note' | 'kbDoc'
  kbId?: string
  title: string
  subtitle?: string
  badge?: '最近' | '收藏'
}

// 键盘导航用的扁平行模型：三种模式共用 ↑↓/Enter/scrollIntoView
type Row =
  | { kind: 'command'; command: CommandItem }
  | { kind: 'title'; item: TitleItem }
  | { kind: 'result'; result: SearchResult }

const FILTERS: { value: SearchHitType; label: string; icon: typeof FileText }[] = [
  { value: 'note', label: '笔记', icon: NotebookPen },
  { value: 'kbDoc', label: '知识文档', icon: FileText },
  { value: 'todo', label: '待办', icon: ListTodo },
  { value: 'annotation', label: '批注', icon: MessageSquareText },
  { value: 'comment', label: '评论', icon: MessageSquareText },
  { value: 'image', label: '图片(OCR)', icon: ImageIcon }
]

function typeIcon(type: SearchHitType) {
  return FILTERS.find((f) => f.value === type)?.icon ?? FileText
}

const TYPE_LABEL: Record<SearchHitType, string> = {
  note: '笔记',
  kbDoc: '知识文档',
  todo: '待办',
  annotation: '批注',
  comment: '评论',
  image: '图片'
}

export function GlobalSearch({ open, mode, onClose, onSelect, commands, notes, kbs }: GlobalSearchProps) {
  const [keyword, setKeyword] = useState('')
  const [filters, setFilters] = useState<Set<SearchHitType>>(new Set(FILTERS.map((f) => f.value)))
  const [sortBy, setSortBy] = useState<SearchSort>('updatedAt')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selectedKbIds, setSelectedKbIds] = useState<Set<string>>(new Set())
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [kbDocsMap, setKbDocsMap] = useState<Record<string, KnowledgeBaseDocSummary[]>>({})
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // 打开（或打开状态下切换模式）时初始化输入并加载数据
  useEffect(() => {
    if (!open) return
    setKeyword(mode === 'command' ? '>' : '')
    setResults([])
    setSelectedKbIds(new Set())
    setSelectedTags(new Set())
    setActiveIdx(0)
    requestAnimationFrame(() => inputRef.current?.focus())
    window.electronAPI.getSettings().then((s) => {
      setHistory((s.searchHistory ?? []).map((h) => h.keyword))
      setRecent(s.recentItems ?? [])
    })
    window.electronAPI.listFavorites().then(setFavorites)
    window.electronAPI.listNotes().then((list) => {
      const tagSet = new Set<string>()
      for (const n of list) for (const t of n.tags ?? []) tagSet.add(t)
      setAllTags(Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')))
    })
    ;(async () => {
      const map: Record<string, KnowledgeBaseDocSummary[]> = {}
      for (const kb of kbs) {
        map[kb.id] = await window.electronAPI.listKbDocs(kb.id)
      }
      setKbDocsMap(map)
    })()
  }, [open, mode, kbs])

  // 命令模式：输入以 > 开头，> 后为命令关键词
  const isCommandMode = keyword.startsWith('>')
  const commandQuery = isCommandMode ? keyword.slice(1).trim().toLowerCase() : ''

  // 防抖全文搜索（200ms）；命令模式与空关键词不触发
  useEffect(() => {
    if (!open || isCommandMode) return
    const parsed = parseQuickSyntax(keyword.trim())
    const q = parsed.keyword
    if (!q) {
      setResults([])
      return
    }
    // type: 快捷语法会强制覆盖勾选的 filters
    let effectiveFilters = Array.from(filters)
    if (parsed.forcedTypes.length) {
      effectiveFilters = parsed.forcedTypes
    }
    setLoading(true)
    const timer = setTimeout(() => {
      const mergedTags = new Set([...parsed.tags, ...Array.from(selectedTags)])
      const mergedKbIds = Array.from(selectedKbIds)
      window.electronAPI
        .search(q, {
          filters: effectiveFilters,
          sortBy,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo ? new Date(dateTo + 'T23:59:59').toISOString() : undefined,
          tags: mergedTags.size ? Array.from(mergedTags) : undefined,
          kbIds: mergedKbIds.length ? mergedKbIds : undefined
        })
        .then((r) => setResults(r))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(timer)
  }, [keyword, filters, sortBy, dateFrom, dateTo, selectedKbIds, selectedTags, open, isCommandMode])

  // 执行搜索时记录历史（仅记录有效关键词）
  const recordHistory = (raw: string) => {
    const parsed = parseQuickSyntax(raw)
    const q = parsed.keyword.trim()
    if (q) void window.electronAPI.recordSearchHistory(q)
  }

  // 全部标题项（Note + KB Doc），供模糊匹配与空态兜底
  const allTitleItems: TitleItem[] = useMemo(() => {
    const all: TitleItem[] = []
    for (const n of notes) all.push({ id: n.id, kind: 'note', title: n.title || '无标题' })
    for (const [kbId, docs] of Object.entries(kbDocsMap)) {
      const kbName = kbs.find((k) => k.id === kbId)?.name
      for (const d of docs) {
        all.push({ id: d.id, kind: 'kbDoc', kbId, title: d.name || '未命名文档', subtitle: kbName })
      }
    }
    return all
  }, [notes, kbDocsMap, kbs])

  // 空态：最近打开在前、收藏在后（去重）；两者皆空时退化为全部标题
  const homeItems: TitleItem[] = useMemo(() => {
    const seen = new Set<string>()
    const list: TitleItem[] = []
    for (const r of recent) {
      const key = `${r.kind}:${r.id}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ id: r.id, kind: r.kind, kbId: r.kbId, title: r.title, badge: '最近' })
    }
    for (const f of favorites) {
      const key = `${f.kind}:${f.id}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ id: f.id, kind: f.kind, kbId: f.kbId, title: f.title, badge: '收藏' })
    }
    if (list.length === 0) {
      return allTitleItems
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
        .slice(0, 50)
    }
    return list
  }, [recent, favorites, allTitleItems])

  // 标题模糊匹配（输入纯关键词时排在全文结果之前）
  const titleMatches: TitleItem[] = useMemo(() => {
    const q = parseQuickSyntax(keyword.trim()).keyword.toLowerCase()
    if (!q) return []
    return allTitleItems
      .map((it) => ({ it, score: fuzzyMatch(q, it.title) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.it)
  }, [allTitleItems, keyword])

  // 命令列表：label + keywords 模糊匹配
  const filteredCommands: CommandItem[] = useMemo(() => {
    if (!commandQuery) return commands.slice(0, 50)
    return commands
      .map((c) => ({
        c,
        score: fuzzyMatch(commandQuery, c.label) + (c.keywords?.reduce((m, k) => m + fuzzyMatch(commandQuery, k), 0) ?? 0)
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.c)
  }, [commands, commandQuery])

  // 三种模式统一的扁平行列表
  const rows: Row[] = useMemo(() => {
    if (isCommandMode) return filteredCommands.map((command) => ({ kind: 'command', command }) as Row)
    if (keyword.trim() === '') return homeItems.map((item) => ({ kind: 'title', item }) as Row)
    return [
      ...titleMatches.map((item) => ({ kind: 'title', item }) as Row),
      ...results.map((result) => ({ kind: 'result', result }) as Row)
    ]
  }, [isCommandMode, filteredCommands, keyword, homeItems, titleMatches, results])

  // 结果变化后重置键盘选中项
  useEffect(() => {
    setActiveIdx(0)
  }, [rows])

  // 键盘移动选中项时滚进视口
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const toggleFilter = (t: SearchHitType) => {
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      // 至少保留一项
      if (next.size === 0) next.add(t)
      return next
    })
  }

  // 选中某一行：命令执行 / 标题项打开 / 全文结果打开
  const activate = (row: Row) => {
    if (row.kind === 'command') {
      void window.electronAPI.recordCommandUse(row.command.id)
      // 先关闭再执行，允许命令重新以其他模式打开本浮层（如「快速打开文件」）
      onClose()
      row.command.run()
      return
    }
    if (row.kind === 'title') {
      const it = row.item
      onSelect({
        type: it.kind,
        id: it.id,
        title: it.title,
        snippet: '',
        kbId: it.kbId,
        docId: it.kind === 'kbDoc' ? it.id : undefined
      })
      onClose()
      return
    }
    recordHistory(keyword)
    onSelect(row.result)
    onClose()
  }

  const placeholder = isCommandMode
    ? '输入命令名…'
    : mode === 'quick'
      ? '输入文件名快速打开（> 开头执行命令）…'
      : '搜索笔记、知识文档、待办、批注…（> 开头执行命令）'

  const countLabel = isCommandMode
    ? `${rows.length} 个命令`
    : keyword.trim() === ''
      ? `${rows.length} 项`
      : `${rows.length} 个结果`

  // 渲染标题项（空态/标题匹配共用）
  const renderTitleItem = (it: TitleItem, idx: number) => {
    const Icon = it.kind === 'note' ? NotebookPen : FileText
    const isActive = idx === activeIdx
    return (
      <li key={`title-${it.kind}-${it.id}-${idx}`}>
        <button
          data-idx={idx}
          onClick={() => activate({ kind: 'title', item: it })}
          onMouseEnter={() => setActiveIdx(idx)}
          className={cn(
            'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
            isActive ? 'bg-[var(--nw-accent-soft)]' : 'hover:bg-[var(--nw-ghost-hover)]'
          )}
        >
          <Icon className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-foreground)]">{it.title}</span>
          {it.subtitle && (
            <span className="truncate text-xs text-[var(--color-muted-foreground)]">{it.subtitle}</span>
          )}
          {it.badge === '最近' ? (
            <Clock className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          ) : it.badge === '收藏' ? (
            <Star className="h-3.5 w-3.5 flex-shrink-0 text-[var(--color-muted-foreground)]" />
          ) : null}
          <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted-foreground)]">
            {it.kind === 'note' ? '笔记' : '文档'}
          </span>
        </button>
      </li>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--color-foreground)]/40 pt-[10vh]" onClick={onClose}>
      <div
        className="flex max-h-[78vh] w-[680px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <Search className="h-4 w-4 text-[var(--color-muted-foreground)]" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveIdx((i) => Math.min(i + 1, rows.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter' && rows.length > 0) {
                e.preventDefault()
                const row = rows[Math.min(activeIdx, rows.length - 1)]
                if (row) activate(row)
              }
            }}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-muted-foreground)]"
          />
          {!isCommandMode && (
            <button
              onClick={() => setSortBy((s) => (s === 'updatedAt' ? 'relevance' : 'updatedAt'))}
              className="btn-ghost"
              title={sortBy === 'updatedAt' ? '当前：按更新时间（点击切相关度）' : '当前：按相关度（点击切更新时间）'}
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              <span className="text-xs">{sortBy === 'updatedAt' ? '时间' : '相关度'}</span>
            </button>
          )}
          <button onClick={onClose} className="btn-icon" title="关闭 (Esc)">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!isCommandMode && (
          <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-3 py-2">
            {FILTERS.map((f) => {
              const Icon = f.icon
              const active = filters.has(f.value)
              return (
                <button
                  key={f.value}
                  onClick={() => toggleFilter(f.value)}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
                    active
                      ? 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                      : 'text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {f.label}
                </button>
              )
            })}
            <div className="ml-auto flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
              <span>更新于</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--color-foreground)] outline-none"
              />
              <span>~</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--color-foreground)] outline-none"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom('')
                    setDateTo('')
                  }}
                  className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  title="清除时间筛选"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* REQ-204 高级筛选：知识库 + 标签 */}
        {!isCommandMode && (kbs.length > 0 || allTags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
            {kbs.length > 0 && (
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md bg-[var(--nw-ghost)] px-2 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]">
                  知识库{selectedKbIds.size > 0 && ` (${selectedKbIds.size})`}
                </summary>
                <div className="absolute z-10 mt-1 max-h-60 w-56 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
                  {kbs.map((kb) => (
                    <label
                      key={kb.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-[var(--nw-ghost-hover)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedKbIds.has(kb.id)}
                        onChange={(e) => {
                          setSelectedKbIds((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(kb.id)
                            else next.delete(kb.id)
                            return next
                          })
                        }}
                      />
                      <span className="truncate">{kb.name}</span>
                    </label>
                  ))}
                </div>
              </details>
            )}
            {allTags.slice(0, 12).map((tag) => {
              const active = selectedTags.has(tag)
              return (
                <button
                  key={tag}
                  onClick={() => {
                    setSelectedTags((prev) => {
                      const next = new Set(prev)
                      if (next.has(tag)) next.delete(tag)
                      else next.add(tag)
                      return next
                    })
                  }}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                    active
                      ? 'bg-[var(--nw-accent-soft)] text-[var(--color-primary)]'
                      : 'bg-[var(--nw-ghost)] text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]'
                  )}
                >
                  #{tag}
                </button>
              )
            })}
            <span className="ml-auto text-[10px] text-[var(--color-muted-foreground)]">
              支持 tag: / kb: / type: 语法
            </span>
          </div>
        )}

        {/* REQ-204 搜索历史（搜索模式空关键词时展示，点击复用） */}
        {!isCommandMode && mode === 'search' && keyword.trim() === '' && history.length > 0 && (
          <div className="border-b border-[var(--color-border)] px-3 py-2">
            <div className="mb-1 text-[11px] text-[var(--color-muted-foreground)]">最近搜索</div>
            <div className="flex flex-wrap gap-1.5">
              {history.map((h) => (
                <button
                  key={h}
                  onClick={() => setKeyword(h)}
                  className="rounded-full bg-[var(--nw-ghost)] px-2 py-0.5 text-[11px] text-[var(--color-muted-foreground)] hover:bg-[var(--nw-ghost-hover)]"
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-[var(--color-muted-foreground)]">
              {loading
                ? '搜索中…'
                : isCommandMode
                  ? '无匹配命令'
                  : keyword.trim() === ''
                    ? '输入关键词开始搜索（Ctrl+Shift+F），> 开头执行命令（Ctrl+Shift+P）'
                    : '未找到匹配结果'}
            </div>
          ) : (
            <>
              <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-muted-foreground)]">
                {countLabel} · ↑↓ 选择，Enter {isCommandMode ? '执行' : '打开'}
              </div>
              <ul ref={listRef} className="py-1">
                {isCommandMode
                  ? rows.map((row, idx) => {
                      if (row.kind !== 'command') return null
                      const c = row.command
                      const isActive = idx === activeIdx
                      return (
                        <li key={`cmd-${c.id}`}>
                          <button
                            data-idx={idx}
                            onClick={() => activate(row)}
                            onMouseEnter={() => setActiveIdx(idx)}
                            className={cn(
                              'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                              isActive ? 'bg-[var(--nw-accent-soft)]' : 'hover:bg-[var(--nw-ghost-hover)]'
                            )}
                          >
                            <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                            <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-foreground)]">
                              {c.label}
                            </span>
                            {c.group && (
                              <span className="text-xs text-[var(--color-muted-foreground)]">{c.group}</span>
                            )}
                          </button>
                        </li>
                      )
                    })
                  : keyword.trim() === ''
                    ? rows.map((row, idx) => (row.kind === 'title' ? renderTitleItem(row.item, idx) : null))
                    : (() => {
                        // 关键词模式：标题匹配分组在前，全文结果分组在后，索引连续
                        let idx = 0
                        const titleRows = titleMatches.map((it) => renderTitleItem(it, idx++))
                        const resultRows = results.map((r) => {
                          const myIdx = idx++
                          const Icon = typeIcon(r.type)
                          const isActive = myIdx === activeIdx
                          return (
                            <li key={`${r.type}-${r.id}-${myIdx}`}>
                              <button
                                data-idx={myIdx}
                                onClick={() => activate({ kind: 'result', result: r })}
                                onMouseEnter={() => setActiveIdx(myIdx)}
                                className={cn(
                                  'flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors',
                                  isActive ? 'bg-[var(--nw-accent-soft)]' : 'hover:bg-[var(--nw-ghost-hover)]'
                                )}
                              >
                                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-muted-foreground)]" />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-sm font-medium text-[var(--color-foreground)]">
                                      {r.title}
                                    </span>
                                    <span className="rounded bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted-foreground)]">
                                      {TYPE_LABEL[r.type]}
                                    </span>
                                  </div>
                                  <p
                                    className="mt-0.5 line-clamp-2 text-xs text-[var(--color-muted-foreground)]"
                                    dangerouslySetInnerHTML={{ __html: r.snippet }}
                                  />
                                </div>
                              </button>
                            </li>
                          )
                        })
                        return (
                          <>
                            {titleRows.length > 0 && (
                              <li className="px-4 pb-1 pt-2 text-[11px] text-[var(--color-muted-foreground)]">
                                标题匹配
                              </li>
                            )}
                            {titleRows}
                            {resultRows.length > 0 && (
                              <li className="px-4 pb-1 pt-2 text-[11px] text-[var(--color-muted-foreground)]">
                                全文结果{loading ? '（搜索中…）' : ''}
                              </li>
                            )}
                            {resultRows}
                          </>
                        )
                      })()}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
