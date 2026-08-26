import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AtSign,
  Check,
  Eye,
  EyeOff,
  FileText,
  History,
  Languages,
  Layout,
  ListTodo,
  MessageSquareText,
  MoreHorizontal,
  PanelRightClose,
  Presentation,
  Search,
  Trash2
} from 'lucide-react'
import { NoteEditor } from './NoteEditor'
import { AnnotatedPreview } from './AnnotatedPreview'
import { AnnotationPanel } from './AnnotationPanel'
import { AnnotationContextMenu } from './AnnotationContextMenu'
import { AnnotationInputPopover } from './AnnotationInputPopover'
import { AiMenu } from './AiMenu'
import { CommentsPanel } from './CommentsPanel'
import { CreateTodoDialog } from './CreateTodoDialog'
import { DocOutline } from './DocOutline'
import { DocPageHeader, DropdownItem } from './DocPageHeader'
import { EditorModeSwitcher } from './EditorModeSwitcher'
import { ExportMenu } from './ExportMenu'
import { FrontMatterCard } from './FrontMatterCard'
import { FindReplaceBar, type FindReplaceController } from './FindReplaceBar'
import { HistoryPanel } from './HistoryPanel'
import { LintPanel } from './LintPanel'
import { LinkPanelDrawer } from './LinkPanelDrawer'
import { LinkSelector } from './LinkSelector'
import { MentionSelector } from './MentionSelector'
import { MilkdownEditor, type MilkdownEditorApi } from './MilkdownEditor'
import { Modal } from './Modal'
import { StatusBar } from './StatusBar'
import { TableToolbar } from './TableToolbar'
import { TagInput } from './TagInput'
import { TagSuggestions } from './TagSuggestions'
import { TranslateDialog } from './TranslateDialog'
import { TimestampButton } from './TimestampButton'
import { Whiteboard } from './Whiteboard'
import { useToast } from './Toast'
import { useConfirm } from './ConfirmDialog'
import { useLinks } from '../hooks/useLinks'
import { useKbDocAnnotations } from '../hooks/useKbDocAnnotations'
import { useSettings } from '../hooks/useSettings'
import { useTagSuggestions } from '../hooks/useTagSuggestions'
import { useTodosForTarget } from '../hooks/useTodosForTarget'
import { useWindowWidth } from '../hooks/useWindowWidth'
import {
  useTextFindReplaceController,
  useMilkdownFindReplaceController
} from '../lib/use-find-replace'
import { formatDateTime, formatFullDate } from '../lib/utils'
import { cn } from '../lib/utils'
import { useSaveStatus, kbDocSaveKey } from '../lib/save-state'
import { countStats } from '../lib/word-count'
import { extractToc } from '../lib/toc'
import {
  captureSelection,
  findExactOverlap,
  isValidSelection,
  resolveOffsets
} from '../lib/annotation'
import { parseFrontMatter, getTags, stripFrontMatter, syncTagsToFrontMatter } from '../lib/front-matter'
import type { Backlink, EditorMode, KbDocAnnotation, KnowledgeBaseDoc } from '../types'

interface KbDocEditorProps {
  doc: KnowledgeBaseDoc
  /** 面包屑前置段（知识库名 + 父级目录链），由 KbDetail 计算；缺省时仅显示文档名 */
  breadcrumbBase?: string[]
  onChange: (partial: Partial<KnowledgeBaseDoc>) => void
  onSave: (doc: KnowledgeBaseDoc) => Promise<KnowledgeBaseDoc>
  onDelete: (docId: string) => void
  onOpenNote?: (noteId: string) => void
  /** 批注增删后由父组件刷新文档列表（更新批注数量） */
  onAnnotationsMutation?: () => void
  /** REQ-116 进入演示模式 */
  onPresent?: (content: string) => void
  /** REQ-201 收藏 */
  isFavorite?: boolean
  onToggleFavorite?: () => void
}

interface MenuState {
  position: { x: number; y: number }
  mode: 'add' | 'edit' | 'disabled'
  reason?: string
  selectedText: string
  start?: number
  end?: number
  existingAnnotation?: KbDocAnnotation
}

interface InputState {
  mode: 'add' | 'edit'
  selectedText: string
  /** 新增批注时定位用的偏移；编辑时复用原批注 */
  start?: number
  end?: number
  initialContent: string
  targetAnnotation?: KbDocAnnotation
}

// 统一右侧栏：批注与评论合并为单一「讨论」面板（数据模型不变，仅 UI 合并展示）；
// 大纲独立为页头开关的右侧抽屉；反链在底部「关联与反链」抽屉。

function docTypeLabel(docType?: string): string {
  switch (docType) {
    case 'mindmap':
      return '思维导图'
    default:
      return '文档'
  }
}

export function KbDocEditor({ doc, breadcrumbBase, onChange, onSave, onDelete, onOpenNote, onAnnotationsMutation, onPresent, isFavorite, onToggleFavorite }: KbDocEditorProps) {
  const { linkedNotes, loadLinkedNotes, removeLink } = useLinks()
  const { annotations, create, update, deleteAnnotation, addReply, deleteReply } = useKbDocAnnotations(
    doc.kbId,
    doc.id,
    onAnnotationsMutation
  )
  const { settings, setEditorMode } = useSettings()
  const toast = useToast()
  const confirm = useConfirm()
  // REQ-012 标签自动补全候选项。
  const tagSuggestions = useTagSuggestions([doc.updatedAt])
  const {
    todos: docTodos,
    create: createDocTodo,
    toggleDone: toggleDocTodo,
    remove: removeDocTodo
  } = useTodosForTarget('kbDoc', doc.id, doc.kbId)
  const [showSelector, setShowSelector] = useState(false)
  const [showCreateTodo, setShowCreateTodo] = useState(false)
  const [viewMode, setViewMode] = useState<'editor' | 'whiteboard'>('editor')
  // editorMode：编辑器模式（REQ-001）：所见 / 即时 / 源码 / 预览 四档统一管理。
  // 阅读优先：默认与文档切换时进入 'preview'（阅读态）；点「编辑」进入所见即所得，「完成」回到预览。
  const [editorMode, setLocalEditorMode] = useState<EditorMode>('preview')
  // REQ-207 只读锁定：锁定时同步派生为预览态（不再用 effect 弹回，避免闪烁）；
  // 编辑档位在 EditorModeSwitcher 中直接禁用（disableEdit），与 NoteDetail 同一方案。
  const effectiveMode: EditorMode = doc.locked ? 'preview' : editorMode
  const preview = effectiveMode === 'preview'
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [input, setInput] = useState<InputState | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  // 保存状态统一来自自动保存生命周期（useKnowledgeBaseDocs 上报的共享状态），Typora 式无手动保存。
  const saveStatus = useSaveStatus(kbDocSaveKey(doc.id))
  // 统一右侧栏「讨论」面板：sideOpen=false 时收起为图标轨道
  // 响应式：初始按窗口宽度决定开闭（宽 ≥1280 开讨论面板、≥1100 开大纲）；
  // 窗口变窄越过阈值时自动收起（不自动重新打开，避免打扰手动选择）。
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth >= 1280)
  // 大纲：页头按钮开关的右侧抽屉，阅读/编辑态均可用
  const [outlineOpen, setOutlineOpen] = useState(() => window.innerWidth >= 1100)
  const windowWidth = useWindowWidth()
  useEffect(() => {
    if (windowWidth < 1280) setSideOpen(false)
    if (windowWidth < 1100) setOutlineOpen(false)
  }, [windowWidth])
  // REQ-202 反链（@提及引用）：合并进底部「关联与反链」抽屉的第二区块
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .listBacklinks('kbDoc', doc.id)
      .then((items) => {
        if (!cancelled) setBacklinks(items)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc.id])
  const [showMention, setShowMention] = useState(false)
  // Markdown 源码模式下的「源码 / 分屏预览」切换
  const [mdLivePreview, setMdLivePreview] = useState(false)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const [showTranslate, setShowTranslate] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const previewContainerRef = useRef<HTMLDivElement>(null)
  // 编辑态滚动容器（供大纲在编辑态定位标题）
  const editorContainerRef = useRef<HTMLDivElement>(null)
  // REQ-101 查找替换
  const [findOpen, setFindOpen] = useState(false)
  const [findReplaceMode, setFindReplaceMode] = useState<'find' | 'replace'>('find')
  const sourceEditorRef = useRef<HTMLDivElement>(null)
  const [milkApi, setMilkApi] = useState<MilkdownEditorApi | null>(null)
  const [selection, setSelection] = useState('')

  // 源码/即时模式：基于 textarea 的查找替换控制器
  const sourceController = useTextFindReplaceController({
    value: doc.content,
    onChange: (next) => onChange({ content: next }),
    containerRef: sourceEditorRef
  })
  // WYSIWYG 模式：基于 Milkdown 命令式接口
  const milkController = useMilkdownFindReplaceController({
    value: doc.content,
    onChange: (next) => onChange({ content: next }),
    editorApi: milkApi
  })
  const activeController: FindReplaceController | null = preview
    ? null
    : effectiveMode === 'wysiwyg'
      ? milkController
      : sourceController

  // Ctrl+F / Ctrl+H 快捷键（仅在编辑态、非预览时生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (preview) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindReplaceMode('find')
        setFindOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setFindReplaceMode('replace')
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  // 跟踪选区文本（用于状态栏「已选 X 字」）
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection()
      setSelection(sel && !sel.isCollapsed ? sel.toString() : '')
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // REQ-103：Front Matter tags ↔ doc.tags 双向同步。
  // 解析 front matter 的 tags 字段；若与 doc.tags 不一致（且 doc.tags 未由用户主动改动），
  // 则以 front matter 的 tags 为准回填 doc.tags，使列表筛选/胶囊能反映 front matter。
  const fmTags = useMemo(() => {
    const parsed = parseFrontMatter(doc.content)
    return getTags(parsed.frontMatter)
  }, [doc.content])
  const effectiveTags = useMemo(() => {
    // 合并 front matter tags 与 doc.tags（去重，front matter 优先顺序在前）
    const merged = [...fmTags]
    for (const t of doc.tags ?? []) {
      if (!merged.includes(t)) merged.push(t)
    }
    return merged
  }, [fmTags, doc.tags])

  // 当 front matter 含 tags 而 doc.tags 未覆盖时，回填一次 doc.tags（保持筛选一致）
  useEffect(() => {
    const fm = fmTags
    const cur = doc.tags ?? []
    const same =
      fm.length === cur.length && fm.every((t, i) => cur[i] === t)
    if (fm.length > 0 && !same) {
      onChange({ tags: fm })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmTags])

  // 标签编辑：同时更新 doc.tags 与 front matter 内容（写回 front matter）
  const handleTagsChange = (tags: string[]) => {
    const nextContent = syncTagsToFrontMatter(doc.content, tags)
    onChange({ tags, content: nextContent })
  }

  useEffect(() => {
    loadLinkedNotes(doc.id)
  }, [doc.id, loadLinkedNotes])

  // 阅读优先：切换文档时默认回到预览（阅读态）；
  // 内容为空的文档（如新建）进入设置中的默认编辑模式，避免空白预览让人误以为不可编辑。
  useEffect(() => {
    setLocalEditorMode(doc.content.trim().length === 0 ? settings.defaultEditorMode : 'preview')
    setMdLivePreview(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  // 切换编辑器模式：仅编辑模式（非 preview）持久化为全局默认，避免把全局默认记成只读预览
  const handleEditorModeChange = (mode: EditorMode) => {
    setLocalEditorMode(mode)
    if (mode === 'wysiwyg') {
      setMdLivePreview(false)
    }
    if (mode !== 'preview') {
      setEditorMode(mode)
    }
  }

  const handleUnlink = async (noteId: string) => {
    await removeLink(noteId, doc.id)
  }

  // 保存状态不再本地跟踪：以 useKnowledgeBaseDocs 自动保存上报为准（见 useSaveStatus）。

  // 锁定/解锁文档（REQ-207）：解锁需二次确认
  const handleToggleLock = async () => {
    const next = !doc.locked
    if (next) {
      onChange({ locked: true })
    } else if (
      await confirm({
        title: '解锁文档',
        description: '确定要解锁这篇文档吗？解锁后可继续编辑。',
        confirmText: '解锁'
      })
    ) {
      onChange({ locked: false })
    }
  }

  // 删除文档：确认后清理仅被本文档引用的图片（REQ-004）
  const handleDeleteDoc = async () => {
    const okDelete = await confirm({
      title: '删除文档',
      description: '确定要删除这篇文档吗？',
      confirmText: '删除',
      danger: true
    })
    if (!okDelete) return
    try {
      const exclusive = await window.electronAPI.findExclusiveAssets({
        kind: 'kbDoc',
        kbId: doc.kbId,
        docId: doc.id,
        content: doc.content
      })
      if (exclusive.length > 0) {
        const okAssets = await confirm({
          title: '一并删除图片？',
          description: `该文档包含 ${exclusive.length} 张仅被本文档引用的图片，是否一并删除？\n（点击「取消」则保留这些图片）`,
          confirmText: '一并删除',
          cancelText: '保留图片',
          danger: true
        })
        if (okAssets) {
          await Promise.all(exclusive.map((u) => window.electronAPI.deleteAsset(u)))
        }
      }
    } catch {
      // 查询失败不阻断删除。
    }
    onDelete(doc.id)
  }

  // 为当前文档创建一条待办任务（关联锁定为本文档）
  const handleCreateTodoForDoc = async (
    title: string,
    detail: string
  ) => {
    await createDocTodo(title, detail)
    setSavedFlash(true)
    window.setTimeout(() => setSavedFlash(false), 1500)
  }

  // 右键触发：校验选区，决定菜单模式
  const handleContextMenu = (position: { x: number; y: number }) => {
    const selection = window.getSelection()
    const check = isValidSelection(selection)
    if (!check.valid) {
      setMenu({ position, mode: 'disabled', reason: check.reason, selectedText: '' })
      return
    }
    const captured = captureSelection(selection, position)
    if (!captured) {
      setMenu({ position, mode: 'disabled', reason: '选中的内容为空', selectedText: '' })
      return
    }

    const offsets = resolveOffsets(captured.text, doc.content)
    if (!offsets) {
      setMenu({ position, mode: 'disabled', reason: '无法在原文中定位选中内容', selectedText: '' })
      return
    }

    // 完全相同范围 → 进入编辑；否则新增
    const existing = findExactOverlap(annotations, offsets.start, offsets.end)
    if (existing) {
      setMenu({
        position,
        mode: 'edit',
        selectedText: captured.text,
        existingAnnotation: existing
      })
    } else {
      setMenu({
        position,
        mode: 'add',
        selectedText: captured.text,
        start: offsets.start,
        end: offsets.end
      })
    }
  }

  const openAddInput = () => {
    if (!menu || menu.start === undefined || menu.end === undefined) return
    setInput({
      mode: 'add',
      selectedText: menu.selectedText,
      start: menu.start,
      end: menu.end,
      initialContent: ''
    })
    setMenu(null)
  }

  const openEditInput = () => {
    if (!menu?.existingAnnotation) return
    setInput({
      mode: 'edit',
      selectedText: menu.existingAnnotation.text,
      initialContent: menu.existingAnnotation.content,
      targetAnnotation: menu.existingAnnotation
    })
    setMenu(null)
  }

  const handleSubmitInput = async (content: string) => {
    if (!input) return
    if (input.mode === 'add' && input.start !== undefined && input.end !== undefined) {
      await create(input.selectedText, input.start, input.end, content)
    } else if (input.mode === 'edit' && input.targetAnnotation) {
      await update({ ...input.targetAnnotation, content })
    }
    setInput(null)
  }

  const handleDeleteAnnotation = async (annotation: KbDocAnnotation) => {
    if (annotation.content.trim().length > 0) {
      const ok = await confirm({
        title: '删除批注',
        description: '确定要删除这条批注吗？',
        confirmText: '删除',
        danger: true
      })
      if (!ok) return
    }
    deleteAnnotation(annotation.id)
  }

  // 点击面板条目：滚动定位到对应高亮
  const handleSelectAnnotation = (annotation: KbDocAnnotation) => {
    const el = previewContainerRef.current?.querySelector(
      `[data-annotation-id="${annotation.id}"]`
    )
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleAnnotationClick = (annotation: KbDocAnnotation) => {
    handleSelectAnnotation(annotation)
  }

  // 语雀式阅读态元信息：字数统计（去 front matter）；大纲可用性（至少一个标题）
  const wordStats = useMemo(() => countStats(stripFrontMatter(doc.content)), [doc.content])
  const outlineAvailable = useMemo(() => extractToc(doc.content).length > 0, [doc.content])

  // 重新打开输入框时清掉浏览器选区，避免视觉残留
  useEffect(() => {
    if (input) {
      window.getSelection()?.removeAllRanges()
    }
  }, [input])

  // 文档切换时关闭浮动菜单/弹窗
  useEffect(() => {
    setMenu(null)
    setInput(null)
  }, [doc.id])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <DocPageHeader
        breadcrumb={[...(breadcrumbBase ?? []), doc.name || '未命名文档']}
        editing={viewMode === 'editor' && !preview}
        onEnterEdit={() => setLocalEditorMode('wysiwyg')}
        onExitEdit={() => setLocalEditorMode('preview')}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        locked={doc.locked}
        onToggleLock={() => void handleToggleLock()}
        outlineAvailable={outlineAvailable}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        extraActions={
          <>
            {/* 文档 / 白板 视图切换（阅读/编辑态均可用） */}
            <div className="segmented">
              <button
                onClick={() => setViewMode('editor')}
                className={cn(
                  'segmented-item',
                  viewMode === 'editor' && 'is-active'
                )}
              >
                <FileText className="h-4 w-4" />
                文档
              </button>
              <button
                onClick={() => setViewMode('whiteboard')}
                className={cn(
                  'segmented-item',
                  viewMode === 'whiteboard' && 'is-active'
                )}
              >
                <Layout className="h-4 w-4" />
                白板
              </button>
            </div>

            {/* 编辑态附加控件：模式切换 + 高频入口（@提及 / AI / 待办 / 时间戳） */}
            {viewMode === 'editor' && !preview && (
              <>
                <EditorModeSwitcher
                  mode={effectiveMode}
                  disableEdit={!!doc.locked}
                  onChange={handleEditorModeChange}
                />
                {effectiveMode !== 'wysiwyg' && (
                  <button
                    onClick={() => setMdLivePreview((v) => !v)}
                    className="btn-icon"
                    title={mdLivePreview ? '关闭分屏预览' : '分屏预览（源码 + 渲染）'}
                  >
                    {mdLivePreview ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                )}
                <button
                  onClick={() => setShowMention(true)}
                  className="btn-icon"
                  title="@提及"
                >
                  <AtSign className="h-4 w-4" />
                </button>
                <AiMenu
                  selectionText={selection}
                  fullText={doc.content}
                  onInsert={(text) => {
                    if (milkApi?.insertMarkdown) milkApi.insertMarkdown(text)
                    else onChange({ content: doc.content + '\n\n' + text })
                  }}
                />
                <button
                  onClick={() => setShowCreateTodo(true)}
                  className="btn-icon"
                  title="创建待办"
                >
                  <ListTodo className="h-4 w-4" />
                </button>
                <TimestampButton value={doc.updatedAt} formatted={formatFullDate(doc.updatedAt)} />
              </>
            )}
            {savedFlash && (
              <span className="flex items-center gap-1 text-xs font-medium text-[var(--color-success)]">
                <Check className="h-3.5 w-3.5" />
                已保存
              </span>
            )}
            {/* 统一保存模型：自动保存为唯一保存路径，不提供手动保存按钮（Typora 式）。
                保存进度见底部状态栏（未保存 / 保存中 / 已保存 + 时间）。 */}
          </>
        }
        moreActions={
          /* 更多操作：低频/危险操作统一收口，删除置底 */
          <div className="relative">
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className="btn-icon"
              title="更多操作"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-52 surface-elevated py-1 text-sm">
                  {!preview && (
                    <DropdownItem
                      onClick={() => {
                        setFindReplaceMode('find')
                        setFindOpen(true)
                        setMoreOpen(false)
                      }}
                      icon={Search}
                      label="查找替换"
                      shortcut="Ctrl+F"
                    />
                  )}
                  {preview && (
                    <AiMenu
                      asMenuItem
                      selectionText={selection}
                      fullText={doc.content}
                      onInsert={(text) => onChange({ content: doc.content + '\n\n' + text })}
                    />
                  )}
                  <DropdownItem
                    onClick={() => {
                      setShowTranslate(true)
                      setMoreOpen(false)
                    }}
                    icon={Languages}
                    label="翻译文档"
                  />
                  <DropdownItem
                    onClick={() => {
                      setFeedbackText(doc.feedback ?? '')
                      setShowFeedback(true)
                      setMoreOpen(false)
                    }}
                    icon={FileText}
                    label="文档反馈"
                  />
                  <div className="divider my-1" />
                  <ExportMenu doc={doc} asMenuItem />
                  {onPresent && (
                    <DropdownItem
                      onClick={() => {
                        onPresent(doc.content)
                        setMoreOpen(false)
                      }}
                      icon={Presentation}
                      label="演示模式"
                    />
                  )}
                  <DropdownItem
                    onClick={() => {
                      setShowHistory(true)
                      setMoreOpen(false)
                    }}
                    icon={History}
                    label="版本历史"
                  />
                  <DropdownItem
                    onClick={async () => {
                      setMoreOpen(false)
                      const name = window.prompt('保存为模板，请输入模板名称', doc.name || '自定义模板')
                      if (!name) return
                      await window.electronAPI.saveTemplate(name, doc.content)
                      setSavedFlash(true)
                      window.setTimeout(() => setSavedFlash(false), 1500)
                    }}
                    icon={FileText}
                    label="存为模板"
                  />
                  <div className="divider my-1" />
                  <DropdownItem
                    danger
                    onClick={() => {
                      setMoreOpen(false)
                      void handleDeleteDoc()
                    }}
                    icon={Trash2}
                    label="删除文档"
                  />
                </div>
              </>
            )}
          </div>
        }
      />

      {viewMode === 'whiteboard' ? (
        <Whiteboard
          doc={doc}
          onOpenContentCard={(kind, targetId, kbId) => {
            if (kind === 'note') onOpenNote?.(targetId)
            else if (kind === 'kbDoc' && kbId) {
              // 同知识库内文档：无法直接切换（KbDocEditor 受控于父），改为新窗口打开
              window.electronAPI.openTargetInNewWindow({ kind: 'kbDoc', id: targetId, kbId })
            }
          }}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 内容区 + 批注面板（左右布局） */}
          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {!preview && (
                <FindReplaceBar
                  open={findOpen}
                  controller={activeController}
                  onClose={() => setFindOpen(false)}
                />
              )}
              {preview ? (
                /* 阅读态：语雀式无框排版，大标题 + 元信息行 + 正文同在居中内容列 */
                <div ref={previewContainerRef} className="min-h-0 flex-1 overflow-y-auto">
                  <div className="doc-content-col py-8">
                    <h1 data-doc-title className="text-[28px] font-semibold leading-snug text-[var(--nw-foreground)]">
                      {doc.name || '未命名文档'}
                    </h1>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--nw-muted-foreground)]">
                      <span className="badge badge-primary">{docTypeLabel(doc.docType)}</span>
                      <span>更新于 {formatDateTime(doc.updatedAt)}</span>
                      <span>字数 {wordStats.words}</span>
                      {effectiveTags.map((tag) => (
                        <span key={tag} className="badge">
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="markdown-body mt-8">
                      {doc.content.trim().length === 0 ? (
                        // 空内容预览占位：避免预览区空白让人误以为内容丢失或不可用。
                        <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--color-muted-foreground)]">
                          <FileText className="mb-3 h-8 w-8" />
                          <p className="text-sm">暂无内容</p>
                          <p className="mt-1 text-xs">点击右上角「编辑」开始编写</p>
                        </div>
                      ) : (
                        <AnnotatedPreview
                          markdown={doc.content}
                          annotations={annotations}
                          onAnnotationClick={handleAnnotationClick}
                          onContextMenu={handleContextMenu}
                          onRemoveImage={async (url) => {
                            const okDelete = await confirm({
                              title: '删除图片',
                              description: '确定删除该图片？将从文档中移除引用并删除文件。',
                              confirmText: '删除',
                              danger: true
                            })
                            if (!okDelete) return
                            const ok = await window.electronAPI.deleteAsset(url)
                            if (ok) {
                              const esc = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                              const next = doc.content.replace(
                                new RegExp(`!\\[[^\\]]*\\]\\(${esc}\\)\\s*`, 'g'),
                                ''
                              )
                              onChange({ content: next })
                            } else {
                              toast.danger('删除失败：文件可能已被移动或删除。')
                            }
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* 编辑态：无边框大标题 + 标签紧凑行，编辑器本体在同一内容列 */}
                  <div className="doc-content-col flex-shrink-0 pt-6">
                    <input
                      type="text"
                      value={doc.name}
                      onChange={(e) => onChange({ name: e.target.value })}
                      placeholder="文档名称"
                      className="w-full bg-transparent text-[28px] font-semibold leading-snug outline-none"
                    />
                    <div className="mb-3 mt-2 flex flex-wrap items-center gap-2">
                      <span className="badge badge-primary flex-shrink-0">{docTypeLabel(doc.docType)}</span>
                      {/* REQ-012 / REQ-103 标签（与 Front Matter tags 双向同步） */}
                      <TagInput
                        tags={effectiveTags}
                        onChange={handleTagsChange}
                        suggestions={tagSuggestions}
                        placeholder="为文档添加标签（回车确认，回写 Front Matter）"
                      />
                    </div>
                    <TagSuggestions
                      text={`${doc.name}\n${doc.content}`}
                      currentTags={effectiveTags}
                      onAddTag={(tag) => handleTagsChange([...effectiveTags, tag])}
                      triggerKey={`${doc.id}-${doc.updatedAt}`}
                    />
                    <FrontMatterCard content={doc.content} />
                  </div>
                  <div ref={editorContainerRef} className="doc-content-col flex min-h-0 w-full flex-1 flex-col pb-4">
                    {effectiveMode === 'wysiwyg' ? (
                      <div className="min-h-0 flex-1">
                        <MilkdownEditor
                          key={doc.id}
                          value={doc.content}
                          onChange={(value) => onChange({ content: value })}
                          assetScope={{ scope: 'kb', ownerId: doc.kbId }}
                          onApi={setMilkApi}
                          focusMode={settings.enableFocusMode}
                          typewriterMode={settings.enableTypewriterMode}
                          spellcheck={settings.enableSpellCheck}
                          autoPair={settings.enableAutoPair}
                        />
                      </div>
                    ) : (
                      <div className="md-source-editor min-h-0 flex-1" ref={sourceEditorRef}>
                        <NoteEditor
                          value={doc.content}
                          onChange={(value) => onChange({ content: value })}
                          preview={mdLivePreview || effectiveMode === 'instant' ? 'live' : 'edit'}
                          hideToolbar
                          placeholder="在此输入 Markdown 源码…"
                          assetScope={{ scope: 'kb', ownerId: doc.kbId }}
                          spellcheck={settings.enableSpellCheck}
                        />
                      </div>
                    )}
                  </div>
                  <StatusBar text={doc.content} selection={selection} saveState={saveStatus.state} savedAt={saveStatus.savedAt} />
                </>
              )}
            </div>

            {!preview && settings.enableLint && (
              <LintPanel content={doc.content} enabled={settings.enableLint} />
            )}

            {/* 大纲右侧抽屉：页头按钮开关，阅读/编辑态均可用 */}
            {outlineOpen && outlineAvailable && (
              <div className="w-64 shrink-0 overflow-y-auto border-l border-[var(--nw-border)] bg-[var(--nw-surface)]">
                <DocOutline
                  embedded
                  markdown={doc.content}
                  containerRef={preview ? previewContainerRef : editorContainerRef}
                />
              </div>
            )}

            {/* 统一右侧栏：批注与评论合并为单一「讨论」面板，可整体收起为图标轨道；编辑态不渲染 */}
            {!preview ? null : sideOpen ? (
              <div className="flex h-full w-80 flex-shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex flex-shrink-0 items-center border-b border-[var(--color-border)] px-3 py-2.5">
                  <MessageSquareText className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                  <span className="ml-1.5 text-xs font-medium text-[var(--color-foreground)]">讨论</span>
                  <button
                    onClick={() => setSideOpen(false)}
                    className="btn-icon ml-auto flex-shrink-0"
                    title="收起侧边栏"
                  >
                    <PanelRightClose className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted-foreground)]">
                    批注
                    <span className="rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px]">
                      {annotations.length}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    <AnnotationPanel
                      embedded
                      annotations={annotations}
                      content={doc.content}
                      onSelect={handleSelectAnnotation}
                      onEdit={(annotation) =>
                        setInput({
                          mode: 'edit',
                          selectedText: annotation.text,
                          initialContent: annotation.content,
                          targetAnnotation: annotation
                        })
                      }
                      onDelete={handleDeleteAnnotation}
                      onAddReply={addReply}
                      onDeleteReply={deleteReply}
                    />
                  </div>
                  <div className="min-h-0 flex-1 border-t border-[var(--color-border)]">
                    <CommentsPanel embedded kbId={doc.kbId} docId={doc.id} onMutation={onAnnotationsMutation} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex w-10 flex-shrink-0 flex-col items-center gap-1 border-l border-[var(--color-border)] bg-[var(--color-surface)] py-2">
                <button
                  onClick={() => setSideOpen(true)}
                  className="btn-icon"
                  title="讨论（批注与评论）"
                >
                  <MessageSquareText className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* REQ-105 表格浮动工具栏（仅在 WYSIWYG 编辑态显示） */}
          {!preview && effectiveMode === 'wysiwyg' && <TableToolbar api={milkApi} />}

          {/* 底部抽屉「关联与待办」：关联小记（可管理）+ 被提及（@提及，只读）+ 待办任务；
              三块内容均为空时不允许展开 */}
          <LinkPanelDrawer
            title="关联与待办"
            sectionTitle="关联小记"
            emptyText="暂无关联小记"
            addLabel="关联小记"
            items={linkedNotes.map((note) => ({
              id: note.id,
              title: note.title || '无标题',
              subtitle: note.summary
            }))}
            onAdd={() => setShowSelector(true)}
            onUnlink={handleUnlink}
            onItemClick={onOpenNote}
            secondarySection={{
              title: '被提及（@提及）',
              items: backlinks
                .filter((b) => !(b.kind === 'note' && linkedNotes.some((n) => n.id === b.id)))
                .map((b) => ({
                  id: `${b.kind}:${b.id}`,
                  title: b.title,
                  subtitle: b.snippet
                })),
              onItemClick: (key) => {
                const b = backlinks.find((x) => `${x.kind}:${x.id}` === key)
                if (b?.kind === 'note') onOpenNote?.(b.id)
              }
            }}
            todoSection={{
              todos: docTodos,
              onToggle: toggleDocTodo,
              onDelete: async (id) => {
                const ok = await confirm({
                  title: '删除待办',
                  description: '确定要删除这条待办吗？',
                  confirmText: '删除',
                  danger: true
                })
                if (ok) {
                  removeDocTodo(id)
                }
              },
              onCreate: () => setShowCreateTodo(true)
            }}
          />
        </div>
      )}

      {showSelector && (
        <LinkSelector
          mode="doc-to-note"
          kbDocId={doc.id}
          onClose={() => setShowSelector(false)}
          onLinked={() => loadLinkedNotes(doc.id)}
        />
      )}

      {showCreateTodo && (
        <CreateTodoDialog
          onClose={() => setShowCreateTodo(false)}
          onCreate={(title, detail) => handleCreateTodoForDoc(title, detail)}
          presetTarget={{
            targetType: 'kbDoc',
            targetId: doc.id,
            kbId: doc.kbId,
            label: doc.name || '未命名文档'
          }}
        />
      )}

      {menu && (
        <AnnotationContextMenu
          position={menu.position}
          mode={menu.mode}
          reason={menu.reason}
          onAdd={openAddInput}
          onEdit={openEditInput}
          onClose={() => setMenu(null)}
        />
      )}

      {input && (
        <AnnotationInputPopover
          selectedText={input.selectedText}
          initialContent={input.initialContent}
          title={input.mode === 'edit' ? '编辑批注' : '添加批注'}
          onSubmit={handleSubmitInput}
          onClose={() => setInput(null)}
        />
      )}

      {showHistory && (
        <HistoryPanel
          scope="kbDoc"
          refId={doc.id}
          currentContent={doc.content}
          onClose={() => setShowHistory(false)}
          onRestore={async (content) => {
            onChange({ content })
            await onSave({ ...doc, content })
          }}
        />
      )}

      <MentionSelector
        open={showMention}
        onClose={() => setShowMention(false)}
        onInsert={(mentionText) => {
          // 优先用 Milkdown API 在光标处插入；否则追加到末尾
          if (milkApi?.insertMarkdown) {
            milkApi.insertMarkdown(mentionText)
          } else {
            onChange({ content: doc.content + mentionText })
          }
        }}
      />

      <TranslateDialog
        open={showTranslate}
        onClose={() => setShowTranslate(false)}
        title={doc.name}
        content={doc.content}
        onTranslated={async (translated, targetLang) => {
          // 创建译文新文档，并在原文与译文之间建立双向 @提及链接
          const newDoc = await window.electronAPI.createKbDoc(doc.kbId, `${doc.name}（${targetLang}）`)
          // 译文末尾追加对原文的提及
          const translatedWithBacklink = `${translated.trim()}\n\n> 译自 [[kbDoc:${doc.id}|${doc.name}]]\n`
          await window.electronAPI.saveKbDoc({ ...newDoc, content: translatedWithBacklink })
          // 原文末尾追加对译文的提及（建立反向链接）
          const mention = `\n\n> [[kbDoc:${newDoc.id}|${newDoc.name}]]\n`
          await onSave({ ...doc, content: doc.content + mention })
        }}
      />

      {showFeedback && (
        <Modal title="文档反馈" onClose={() => setShowFeedback(false)}>
          <div className="mb-2 text-sm font-semibold">文档反馈</div>
          <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
            针对整篇文档的总体反馈，保存到文档元数据。
          </p>
          <textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            rows={4}
            placeholder="写下你对这篇文档的反馈…"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={() => setShowFeedback(false)}
              className="btn-secondary"
            >
              取消
            </button>
            <button
              onClick={async () => {
                onChange({ feedback: feedbackText.trim() || null })
                await onSave({ ...doc, feedback: feedbackText.trim() || null })
                setShowFeedback(false)
              }}
              className="btn-primary"
            >
              保存
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
