import { useEffect, useMemo, useRef, useState } from 'react'
import { Trash2, ListTodo, Languages, FileText, MoreHorizontal, Search, Eye, EyeOff } from 'lucide-react'
import { DocPageHeader, DropdownItem } from './DocPageHeader'
import { EditorModeSwitcher } from './EditorModeSwitcher'
import { MilkdownEditor, type MilkdownEditorApi } from './MilkdownEditor'
import { NoteEditor } from './NoteEditor'
import { NotePreview } from './NotePreview'
import { DocOutline } from './DocOutline'
import { FindReplaceBar, type FindReplaceController } from './FindReplaceBar'
import { LinkedDocsPanel } from './LinkedDocsPanel'
import { AiMenu } from './AiMenu'
import { EmptyState } from './EmptyState'
import { LinkSelector } from './LinkSelector'
import { StatusBar } from './StatusBar'
import { TimestampButton } from './TimestampButton'
import { CreateKbDocDialog } from './CreateKbDocDialog'
import { CreateTodoDialog } from './CreateTodoDialog'
import { TodoPanel } from './TodoPanel'
import { TagInput } from './TagInput'
import { TagSuggestions } from './TagSuggestions'
import { TranslateDialog } from './TranslateDialog'
import { useToast } from './Toast'
import { useConfirm } from './ConfirmDialog'
import { useLinks } from '../hooks/useLinks'
import { useSettings } from '../hooks/useSettings'
import { useTodosForTarget } from '../hooks/useTodosForTarget'
import { useWindowWidth } from '../hooks/useWindowWidth'
import { useTagSuggestions } from '../hooks/useTagSuggestions'
import { useSaveStatus, noteSaveKey } from '../lib/save-state'
import { useTextFindReplaceController, useMilkdownFindReplaceController } from '../lib/use-find-replace'
import { formatDateTime, formatFullDate } from '../lib/utils'
import { countStats } from '../lib/word-count'
import { extractToc } from '../lib/toc'
import { parseFrontMatter, getTags, stripFrontMatter, syncTagsToFrontMatter } from '../lib/front-matter'
import type { EditorMode, Note, NoteGroup } from '../types'

interface NoteDetailProps {
  note: Note | null
  isLoading: boolean
  groups: NoteGroup[]
  /** 面包屑前置段（UE-04：工作台 / 小记 / 标题）；从知识库上下文打开时传 ['知识库', '小记'] */
  breadcrumbBase?: string[]
  onChange: (partial: Partial<Note>) => void
  onSave: (note: Note) => Promise<Note>
  onDelete: (id: string) => void
  onOpenKbDoc?: (kbId: string, docId: string) => void
  /** REQ-201 收藏 */
  isFavorite?: boolean
  onToggleFavorite?: () => void
  /** 返回工作台（页头左侧返回箭头）；不传则不显示 */
  onBack?: () => void
}

export function NoteDetail({ note, isLoading, groups, breadcrumbBase, onChange, onSave, onDelete, onOpenKbDoc, isFavorite, onToggleFavorite, onBack }: NoteDetailProps) {
  const { settings, setEditorMode } = useSettings()
  // 编辑器模式（REQ-001）：所见 / 即时 / 源码 / 预览 四档统一管理。
  // 阅读优先：默认与切换笔记时进入 'preview'（阅读态）；点「编辑」进入所见即所得，「完成」回到预览。
  // 切到任意编辑模式（非 preview）时持久化为全局默认，方便下次复用。
  const [editorMode, setLocalEditorMode] = useState<EditorMode>('preview')
  // REQ-207 只读锁定：锁定时同步派生为预览态（不再用 effect 弹回，避免闪烁）；
  // 编辑档位在 EditorModeSwitcher 中直接禁用（disableEdit）。
  const effectiveMode: EditorMode = note?.locked ? 'preview' : editorMode
  const preview = effectiveMode === 'preview'
  // REQ-007 大纲：页头按钮开关的右侧抽屉，阅读/编辑态均可用。
  // 响应式：宽 ≥1100 默认展开；窗口变窄越过阈值时自动收起（不自动重新打开）。
  const [outlineOpen, setOutlineOpen] = useState(() => window.innerWidth >= 1100)
  const windowWidth = useWindowWidth()
  useEffect(() => {
    if (windowWidth < 1100) setOutlineOpen(false)
  }, [windowWidth])
  // 正文预览滚动容器，供 DocOutline 查询标题元素并滚动定位。
  const previewContainerRef = useRef<HTMLDivElement>(null)
  // 编辑态滚动容器（供大纲在编辑态定位标题）
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const [showSelector, setShowSelector] = useState(false)
  const [showCreateKbDoc, setShowCreateKbDoc] = useState(false)
  const [showCreateTodo, setShowCreateTodo] = useState(false)
  const [showTranslate, setShowTranslate] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  // Markdown 源码模式下的「源码 / 分屏预览」切换
  const [mdLivePreview, setMdLivePreview] = useState(false)
  // 保存状态统一来自自动保存生命周期（useNotes 上报的共享状态），Typora 式无手动保存。
  const saveStatus = useSaveStatus(note ? noteSaveKey(note.id) : null)
  // REQ-101 查找替换（源码/即时走 textarea 控制器；所见走 Milkdown 命令接口）
  const [findOpen, setFindOpen] = useState(false)
  const sourceEditorRef = useRef<HTMLDivElement>(null)
  const [milkApi, setMilkApi] = useState<MilkdownEditorApi | null>(null)
  const toast = useToast()
  const confirm = useConfirm()
  const { linkedDocs, loadLinkedDocs, removeLink, addLink } = useLinks()
  // REQ-012 标签自动补全候选项（聚合全部 Note 与 KB Doc）。
  const tagSuggestions = useTagSuggestions([note?.updatedAt])

  // REQ-103：Front Matter tags ↔ note.tags 双向同步
  const fmTags = useMemo(() => {
    if (!note) return []
    return getTags(parseFrontMatter(note.content).frontMatter)
  }, [note?.content])
  const effectiveTags = useMemo(() => {
    if (!note) return []
    const merged = [...fmTags]
    for (const t of note.tags ?? []) {
      if (!merged.includes(t)) merged.push(t)
    }
    return merged
  }, [fmTags, note?.tags])
  useEffect(() => {
    if (!note) return
    const cur = note.tags ?? []
    const same = fmTags.length === cur.length && fmTags.every((t, i) => cur[i] === t)
    if (fmTags.length > 0 && !same) {
      onChange({ tags: fmTags })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmTags])
  const handleTagsChange = (tags: string[]) => {
    if (!note) return
    onChange({ tags, content: syncTagsToFrontMatter(note.content, tags) })
  }
  const {
    todos: noteTodos,
    create: createNoteTodo,
    toggleDone: toggleNoteTodo,
    remove: removeNoteTodo
  } = useTodosForTarget('note', note?.id)

  useEffect(() => {
    if (note?.id) {
      loadLinkedDocs(note.id)
    }
  }, [note?.id, loadLinkedDocs])

  // 阅读优先：切换笔记时默认回到预览（阅读态）；
  // 内容为空的笔记（如新建）进入设置中的默认编辑模式，避免空白预览让人误以为不可编辑。
  useEffect(() => {
    if (!note) return
    setLocalEditorMode(note.content.trim().length === 0 ? settings.defaultEditorMode : 'preview')
    setMdLivePreview(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id])

  // REQ-101 查找替换控制器：源码/即时模式基于 textarea，所见模式基于 Milkdown 命令接口。
  const noteContent = note?.content ?? ''
  const sourceController = useTextFindReplaceController({
    value: noteContent,
    onChange: (next) => onChange({ content: next }),
    containerRef: sourceEditorRef
  })
  const milkController = useMilkdownFindReplaceController({
    value: noteContent,
    onChange: (next) => onChange({ content: next }),
    editorApi: milkApi
  })
  const activeController: FindReplaceController | null =
    preview ? null : effectiveMode === 'wysiwyg' ? milkController : sourceController

  // Ctrl+F 唤起查找替换（仅编辑态生效；预览态无需查找）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (preview) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [preview])

  const handleCreateKbDoc = async (kbId: string, name: string) => {
    if (!note?.id) return
    const doc = await window.electronAPI.createKbDoc(kbId, name || '未命名文档')
    await addLink(note.id, doc.id)
  }

  // REQ-207 文档只读锁定：锁定时 effectiveMode 派生为 preview（见上方），无需 effect。

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--color-muted-foreground)]">加载中…</div>
    )
  }

  if (!note) {
    return <EmptyState />
  }

  // 语雀式阅读态元信息：字数统计（去 front matter）、大纲可用性（至少一个标题）、所属分组名
  const wordStats = countStats(stripFrontMatter(note.content))
  const outlineAvailable = extractToc(note.content).length > 0
  const groupName = note.groupId ? groups.find((g) => g.id === note.groupId)?.name : null

  // REQ-207 只读锁定：解锁需二次确认
  const handleToggleLock = async () => {
    const next = !note.locked
    if (next) {
      onChange({ locked: true })
    } else if (
      await confirm({
        title: '解锁笔记',
        description: '确定要解锁这条笔记吗？解锁后可继续编辑。',
        confirmText: '解锁'
      })
    ) {
      onChange({ locked: false })
    }
  }

  // 删除笔记：确认后清理仅被本笔记引用的图片（REQ-004）
  const handleDeleteNote = async () => {
    const ok = await confirm({
      title: '删除笔记',
      description: '确定要删除这条笔记吗？',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    try {
      const exclusive = await window.electronAPI.findExclusiveAssets({
        kind: 'note',
        noteId: note.id,
        content: note.content
      })
      if (exclusive.length > 0) {
        const okAssets = await confirm({
          title: '一并删除图片？',
          description: `该笔记包含 ${exclusive.length} 张仅被本笔记引用的图片，是否一并删除？\n（点击「取消」则保留这些图片）`,
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
    onDelete(note.id)
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      <DocPageHeader
        breadcrumb={[...(breadcrumbBase ?? ['工作台', '小记']), note.title || '无标题']}
        onBack={onBack}
        editing={!preview}
        onEnterEdit={() => setLocalEditorMode('wysiwyg')}
        onExitEdit={() => setLocalEditorMode('preview')}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        locked={note.locked}
        onToggleLock={() => void handleToggleLock()}
        outlineAvailable={outlineAvailable}
        outlineOpen={outlineOpen}
        onToggleOutline={() => setOutlineOpen((v) => !v)}
        extraActions={
          <>
            {/* 编辑态附加控件：模式切换 + 高频入口（AI / 待办 / 时间戳） */}
            {!preview && (
              <>
                {/* 编辑器模式切换（语雀式两档：富文本 / Markdown）；锁定时禁用（REQ-207） */}
                <EditorModeSwitcher
                  mode={effectiveMode}
                  disableEdit={!!note.locked}
                  onChange={(mode) => {
                    setLocalEditorMode(mode)
                    if (mode === 'wysiwyg') {
                      setMdLivePreview(false)
                    }
                    // 仅编辑模式持久化为全局默认（避免把全局默认记成只读预览）
                    if (mode !== 'preview') {
                      setEditorMode(mode)
                    }
                  }}
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
                <AiMenu
                  selectionText=""
                  fullText={note.content}
                  onInsert={(text) => onChange({ content: note.content + '\n\n' + text })}
                />
                <button
                  onClick={() => setShowCreateTodo(true)}
                  className="btn-icon"
                  title="为这条笔记创建待办任务"
                >
                  <ListTodo className="h-4 w-4" />
                </button>
                <TimestampButton value={note.updatedAt} formatted={formatFullDate(note.updatedAt)} />
              </>
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
                      selectionText=""
                      fullText={note.content}
                      onInsert={(text) => onChange({ content: note.content + '\n\n' + text })}
                    />
                  )}
                  <DropdownItem
                    onClick={() => {
                      setShowTranslate(true)
                      setMoreOpen(false)
                    }}
                    icon={Languages}
                    label="翻译笔记"
                  />
                  <div className="divider my-1" />
                  <DropdownItem
                    danger
                    onClick={() => {
                      setMoreOpen(false)
                      void handleDeleteNote()
                    }}
                    icon={Trash2}
                    label="删除笔记"
                  />
                </div>
              </>
            )}
          </div>
        }
      />

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
                  <NotePreview
                    markdown={note.title || '无标题'}
                    allowedElements={['strong', 'em', 'code', 'a', 'del', 'span']}
                  />
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-[var(--nw-muted-foreground)]">
                  <span>更新于 {formatDateTime(note.updatedAt)}</span>
                  <span>字数 {wordStats.words}</span>
                  {groupName && <span>分组：{groupName}</span>}
                  {effectiveTags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="markdown-body mt-8">
                  {note.content.trim().length === 0 ? (
                    // 空内容预览占位：避免预览区只渲染一个空格、看起来「没内容」的 bug。
                    <div className="flex flex-col items-center justify-center py-16 text-center text-[var(--color-muted-foreground)]">
                      <FileText className="mb-3 h-8 w-8" />
                      <p className="text-sm">暂无内容</p>
                      <p className="mt-1 text-xs">点击右上角「编辑」开始编写</p>
                    </div>
                  ) : (
                    <NotePreview
                      markdown={note.content}
                      enableImageMenu
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
                          const next = note.content.replace(
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
              {/* 编辑态：无边框大标题 + 分组/标签紧凑行，编辑器本体在同一内容列 */}
              <div className="doc-content-col flex-shrink-0 pt-6">
                <input
                  type="text"
                  id="note-title-editor"
                  value={note.title}
                  onChange={(e) => onChange({ title: e.target.value })}
                  placeholder="无标题"
                  className="w-full bg-transparent text-[28px] font-semibold leading-snug outline-none"
                />
                <div className="mb-3 mt-2 flex flex-wrap items-center gap-2">
                  <select
                    id="note-group-select"
                    value={note.groupId ?? ''}
                    onChange={(e) => onChange({ groupId: e.target.value === '' ? null : e.target.value })}
                    className="input max-w-[16rem] px-2 py-1 text-xs"
                    title="所属分组"
                  >
                    <option value="">未分类</option>
                    {groups
                      .filter((g) => g.parentId === null)
                      .map((parent) => {
                        const children = groups.filter((g) => g.parentId === parent.id)
                        return (
                          <optgroup label={parent.name} key={parent.id}>
                            <option value={parent.id}>{parent.name}</option>
                            {children.map((child) => (
                              <option value={child.id} key={child.id}>
                                {parent.name} / {child.name}
                              </option>
                            ))}
                          </optgroup>
                        )
                      })}
                  </select>
                  <TagInput
                    inputId="note-tags-input"
                    tags={effectiveTags}
                    onChange={handleTagsChange}
                    suggestions={tagSuggestions}
                    placeholder="为笔记添加标签（回车确认，回写 Front Matter）"
                  />
                </div>
                <TagSuggestions
                  text={`${note.title}\n${note.content}`}
                  currentTags={effectiveTags}
                  onAddTag={(tag) => handleTagsChange([...effectiveTags, tag])}
                  triggerKey={`${note.id}-${note.updatedAt}`}
                />
              </div>
              <div ref={editorContainerRef} className="doc-content-col flex min-h-0 w-full flex-1 flex-col pb-4">
                {effectiveMode === 'wysiwyg' ? (
                  <div className="min-h-0 flex-1">
                    <MilkdownEditor
                      key={note.id}
                      value={note.content}
                      onChange={(value) => onChange({ content: value })}
                      assetScope={{ scope: 'note', ownerId: note.id }}
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
                      textareaId="note-content-editor"
                      value={note.content}
                      onChange={(value) => onChange({ content: value })}
                      preview={mdLivePreview || effectiveMode === 'instant' ? 'live' : 'edit'}
                      hideToolbar
                      placeholder="在此输入 Markdown 源码…"
                      assetScope={{ scope: 'note', ownerId: note.id }}
                      spellcheck={settings.enableSpellCheck}
                    />
                  </div>
                )}
              </div>
              <StatusBar text={note.content} saveState={saveStatus.state} savedAt={saveStatus.savedAt} />
            </>
          )}
        </div>

        {/* 大纲右侧抽屉：页头按钮开关，阅读/编辑态均可用 */}
        {outlineOpen && outlineAvailable && (
          <div className="w-64 shrink-0 overflow-y-auto border-l border-[var(--nw-border)] bg-[var(--nw-surface)]">
            <DocOutline
              embedded
              markdown={note.content}
              containerRef={preview ? previewContainerRef : editorContainerRef}
            />
          </div>
        )}
      </div>

      {note.id && (
        <LinkedDocsPanel
          linkedDocs={linkedDocs}
          onOpenKbDoc={onOpenKbDoc}
          onRemoveLink={async (docId) => {
            await removeLink(note.id, docId)
          }}
          onAdd={() => setShowSelector(true)}
          onCreate={() => setShowCreateKbDoc(true)}
        />
      )}

      <TodoPanel
        todos={noteTodos}
        onToggle={toggleNoteTodo}
        onDelete={async (id) => {
          const ok = await confirm({
            title: '删除待办',
            description: '确定要删除这条待办吗？',
            confirmText: '删除',
            danger: true
          })
          if (ok) {
            removeNoteTodo(id)
          }
        }}
        onCreate={() => setShowCreateTodo(true)}
      />

      {showSelector && (
        <LinkSelector
          mode="note-to-doc"
          noteId={note.id}
          onClose={() => setShowSelector(false)}
          onLinked={() => loadLinkedDocs(note.id)}
        />
      )}

      {showCreateKbDoc && (
        <CreateKbDocDialog
          onClose={() => setShowCreateKbDoc(false)}
          onCreate={handleCreateKbDoc}
        />
      )}

      {showCreateTodo && (
        <CreateTodoDialog
          onClose={() => setShowCreateTodo(false)}
          onCreate={async (title, detail) => {
            await createNoteTodo(title, detail)
          }}
          presetTarget={{
            targetType: 'note',
            targetId: note.id,
            label: note.title || '无标题'
          }}
        />
      )}

      <TranslateDialog
        open={showTranslate}
        onClose={() => setShowTranslate(false)}
        title={note.title}
        content={note.content}
        onTranslated={async (translated, targetLang) => {
          // 创建译文新笔记，并在原文与译文之间建立双向 @提及链接
          const newNote = await window.electronAPI.createNote(note.groupId ?? null)
          const translatedWithBacklink = `${translated.trim()}\n\n> 译自 [[note:${note.id}|${note.title || '无标题'}]]\n`
          await window.electronAPI.saveNote({
            ...newNote,
            title: `${note.title || '无标题'}（${targetLang}）`,
            content: translatedWithBacklink
          })
          // 原文追加对译文的提及
          const mention = `\n\n> [[note:${newNote.id}|${newNote.title || '无标题'}]]\n`
          await onSave({ ...note, content: note.content + mention })
        }}
      />
    </div>
  )
}
