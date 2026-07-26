import { useEffect, useMemo, useRef, useState } from 'react'
import { AppNavRail } from './components/AppNavRail'
import { Dashboard } from './components/Dashboard'
import { KbGridPage } from './components/KbGridPage'
import { NoteDetail } from './components/NoteDetail'
import { KbDetail } from './components/KbDetail'
import { AssetManagerPanel } from './components/AssetManagerPanel'
import {
  GlobalSearch,
  type CommandItem,
  type SearchPaletteMode
} from './components/GlobalSearch'
import { CreateKbDialog } from './components/CreateKbDialog'
import { CreateNoteDialog } from './components/CreateNoteDialog'
import { CreateTodoDialog } from './components/CreateTodoDialog'
import { PresentationMode } from './components/PresentationMode'
import { SettingsDialog } from './components/SettingsDialog'
import { TemplatePickerDialog } from './components/TemplatePickerDialog'
import { ImportExternalDialog } from './components/ImportExternalDialog'
import { ExportKbDialog } from './components/ExportKbDialog'
import { QuickNoteWindow } from './components/QuickNoteWindow'
import { TodoEditorDialog } from './components/TodoEditorDialog'
import { TrashPanel } from './components/TrashPanel'
import { ToastProvider } from './components/Toast'
import { ConfirmDialogProvider, useConfirm } from './components/ConfirmDialog'
import { useNotes } from './hooks/useNotes'
import { useNoteGroups } from './hooks/useNoteGroups'
import { useKnowledgeBases } from './hooks/useKnowledgeBases'
import { useKnowledgeBaseDocs } from './hooks/useKnowledgeBaseDocs'
import { useTodos } from './hooks/useTodos'
import { useFavorites } from './hooks/useFavorites'
import { useAppLock } from './hooks/useAppLock'
import { LockScreen } from './components/LockScreen'
import { useSettings, reloadSettings } from './hooks/useSettings'
import { useTheme } from './hooks/useTheme'
import type { ElectronAPI, ImportExternalResult, Todo } from './types'

function App() {
  const urlParams = new URLSearchParams(window.location.search)
  const isQuickNoteWindow = urlParams.get('quicknote') === '1'

  // REQ-010 主题：应用主题。
  useTheme()

  // 语雀式信息架构：一级视图只有「工作台 / 知识库」；小记详情为覆盖层（selectedNoteId != null）。
  const [view, setView] = useState<'dashboard' | 'knowledge-base'>('dashboard')
  const [showCreateNote, setShowCreateNote] = useState(false)
  const [showCreateKb, setShowCreateKb] = useState(false)
  const [showCreateTodo, setShowCreateTodo] = useState(false)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null)
  const [docCounts, setDocCounts] = useState<Record<string, number>>({})
  // 三合一搜索浮层：search=全文搜索(Ctrl+Shift+F) / quick=快速打开(Ctrl+P) / command=命令(Ctrl+Shift+P)
  const [paletteMode, setPaletteMode] = useState<SearchPaletteMode | null>(null)
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showAssets, setShowAssets] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [importExternalResult, setImportExternalResult] = useState<ImportExternalResult | null>(null)
  // REQ-210 批量导出知识库
  const [exportKbTarget, setExportKbTarget] = useState<{ id: string; name: string } | null>(null)
  const [presentingContent, setPresentingContent] = useState<string | null>(null)
  const { update: updateSettings, settings } = useSettings()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // REQ-005：搜索结果定位用——跳转到目标后在其内容里查找并高亮该关键词。
  const [pendingSearchTerm, setPendingSearchTerm] = useState('')
  const {
    notes,
    selectedId: selectedNoteId,
    setSelectedId: setSelectedNoteId,
    selectedNote,
    isLoading: isNoteLoading,
    createNote,
    saveNote,
    changeNote,
    deleteNote,
    refresh: refreshNotes
  } = useNotes()

  const {
    groups: noteGroups,
    createGroup: createNoteGroup,
    updateGroup: updateNoteGroup,
    deleteGroup: deleteNoteGroup,
    refresh: refreshNoteGroups
  } = useNoteGroups()

  // 记录从侧边栏树形节点触发「新建」时的目标分组；null=未分类。
  const [createNoteTargetGroup, setCreateNoteTargetGroup] = useState<string | null>(null)

  const {
    kbs,
    selectedId: selectedKbId,
    setSelectedId: setSelectedKbId,
    selectedKb,
    isLoading: isKbLoading,
    createKb,
    deleteKb,
    refresh: refreshKbs
  } = useKnowledgeBases()

  const {
    docs,
    selectedId: selectedDocId,
    setSelectedId: setSelectedDocId,
    selectedDoc,
    isLoading: isDocLoading,
    createDoc,
    saveDoc,
    changeDoc,
    deleteDoc,
    moveDoc,
    deleteDocCascade,
    refresh: refreshDocs
  } = useKnowledgeBaseDocs(selectedKbId)

  const {
    todos,
    isLoading: isTodoLoading,
    load: loadTodos,
    create: createTodo,
    save: saveTodo,
    toggleDone,
    remove: deleteTodo
  } = useTodos()

  // REQ-201 收藏夹（全局共享：列表项星标 + 工作台收藏 Tab）
  const {
    favorites,
    isFavorite: isFav,
    toggle: toggleFavorite,
    removeFavorite
  } = useFavorites()

  // REQ-208 应用锁屏
  const { locked, lockNow, unlock } = useAppLock()

  // 统一确认对话框（promise 式，替代 window.confirm）
  const confirm = useConfirm()

  // 工作台包含待办 Tab：NoteDetail / KbDocEditor 直接通过 electronAPI 创建待办，
  // 不会经过这里的 useTodos，因此回到工作台时必须重新拉取，否则新创建的待办看不到。
  useEffect(() => {
    if (view === 'dashboard') {
      loadTodos()
    }
  }, [view, loadTodos])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuSave(() => {
      if (selectedNoteId && selectedNote) {
        saveNote(selectedNote)
      } else if (view === 'knowledge-base' && selectedDoc) {
        saveDoc(selectedDoc)
      }
    })
    return unsubscribe
  }, [view, selectedNoteId, selectedNote, saveNote, selectedDoc, saveDoc])

  useEffect(() => {
    const unsubscribe = window.electronAPI.onMenuImportComplete(() => {
      handleImportComplete()
    })
    return unsubscribe
  }, [])

  // REQ-005 全局搜索快捷键 Ctrl+Shift+F；REQ-108 命令面板 Ctrl+Shift+P；
  // REQ-109 快速打开 Ctrl+P；REQ-117 新窗口 Ctrl+Shift+N；REQ-107 打字机/Focus。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setPaletteMode('search')
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteMode('command')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPaletteMode('quick')
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        window.electronAPI.openTargetInNewWindow({ kind: 'note', id: selectedNoteId ?? '' })
      } else if (e.key === 'F11') {
        e.preventDefault()
        updateSettings({ enableFocusMode: !settingsRef.current.enableFocusMode })
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        updateSettings({ enableTypewriterMode: !settingsRef.current.enableTypewriterMode })
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'l') {
        // REQ-208 立即锁屏
        e.preventDefault()
        lockNow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (view !== 'knowledge-base') return
    let cancelled = false
    async function loadCounts() {
      const counts: Record<string, number> = {}
      for (const kb of kbs) {
        const docs = await window.electronAPI.listKbDocs(kb.id)
        counts[kb.id] = docs.length
      }
      if (!cancelled) setDocCounts(counts)
    }
    loadCounts()
    return () => {
      cancelled = true
    }
  }, [kbs, view])

  // 语雀式导航：工作台 / 知识库两个一级入口。切换时退出小记详情覆盖层；
  // 进入知识库时回到知识库网格页（清空 KB 内部选中态）。
  const handleNavigate = (target: 'dashboard' | 'knowledge-base') => {
    setView(target)
    setSelectedNoteId(null)
    if (target === 'knowledge-base') {
      setSelectedKbId(null)
      setSelectedDocId(null)
    }
  }

  const handleCreateNote = async (title: string, groupId: string | null) => {
    const note = await createNote(groupId)
    const withTitle = title ? { ...note, title } : note
    if (title) {
      await saveNote(withTitle)
    }
  }

  // 在侧边栏树形节点点击「新建」时：直接创建一条空白提示并选中编辑。
  const handleCreateNoteInGroup = async (groupId: string | null) => {
    await createNote(groupId)
  }

  const handleCreateKb = async (name: string, category: string) => {
    await createKb(name, category)
  }

  const handleOpenNote = (noteId: string) => {
    // 小记详情为覆盖层：保留当前 view，返回时回到原上下文。
    setSelectedNoteId(noteId)
  }

  const handleOpenKbDoc = (kbId: string, docId: string) => {
    setSelectedNoteId(null)
    setSelectedKbId(kbId)
    setSelectedDocId(docId)
    setView('knowledge-base')
  }

  // 全局新建待办：自由选择关联对象（或不关联）
  const handleCreateTodo = async (
    title: string,
    detail: string,
    targetType: 'note' | 'kbDoc' | null,
    targetId: string | null,
    kbId?: string
  ) => {
    if (!targetType || !targetId) {
      // 无关联待办：targetId 留空，targetType 占位为 note（仅作类型合法性用）
      await createTodo(title, detail, 'note', '')
      return
    }
    await createTodo(title, detail, targetType, targetId, kbId)
  }

  // 待办列表项点击：跳转到关联的便签/文档
  const handleOpenTodoTarget = (todo: Todo) => {
    if (todo.targetType === 'note') {
      handleOpenNote(todo.targetId)
    } else if (todo.targetType === 'kbDoc' && todo.kbId) {
      handleOpenKbDoc(todo.kbId, todo.targetId)
    }
  }

  const handleImportComplete = () => {
    setSelectedNoteId(null)
    setSelectedKbId(null)
    setSelectedDocId(null)
    refreshNotes()
    refreshNoteGroups()
    refreshKbs()
    // 还原 settings.json 后失效进程内设置缓存并重新加载，使主题/编辑器模式等立即生效。
    void reloadSettings()
  }

  const handleExport = async () => {
    await window.electronAPI.exportAllData()
  }

  const handleImport = async () => {
    const result = await window.electronAPI.importData()
    if (result.success) {
      handleImportComplete()
    }
  }

  // REQ-209 批量导入外部文件（.docx/.html/.md/Notion ZIP）到指定知识库
  const handleImportExternal = async (targetKbId: string | null) => {
    const result = await window.electronAPI.importExternalFiles(targetKbId)
    if (result.success) {
      refreshKbs()
      if (result.kbId === selectedKbId) refreshDocs()
      setImportExternalResult(result)
    }
  }

  // REQ-005：搜索结果跳转 + 定位到匹配关键词
  const handleSearchSelect = (r: { type: string; id: string; kbId?: string; docId?: string; matchText?: string }) => {
    const term = r.matchText ?? ''
    if (term) setPendingSearchTerm(term)
    if (r.type === 'note') {
      handleOpenNote(r.id)
    } else if (r.type === 'kbDoc' && r.kbId && r.docId) {
      handleOpenKbDoc(r.kbId, r.docId)
    } else if (r.type === 'todo') {
      setSelectedNoteId(null)
      setView('dashboard')
    } else if (r.type === 'annotation' && r.kbId && r.docId) {
      handleOpenKbDoc(r.kbId, r.docId)
    } else if (r.type === 'comment' && r.kbId && r.docId) {
      handleOpenKbDoc(r.kbId, r.docId)
    } else if (r.type === 'image' && r.docId) {
      // REQ-205 图片搜索结果：docId 携带 asset URL，在外部查看器打开
      window.electronAPI.openImageExternally(r.docId)
    }
  }

  // 打开后用浏览器内置查找定位关键词（延迟一帧等待内容渲染）
  useEffect(() => {
    if (!pendingSearchTerm) return
    const t = setTimeout(() => {
      const found = (window as unknown as { find?: (s: string) => boolean }).find?.(pendingSearchTerm)
      void found
      setPendingSearchTerm('')
    }, 400)
    return () => clearTimeout(t)
  }, [pendingSearchTerm, selectedNoteId, selectedDocId])

  // REQ-108/109/116/107 菜单事件桥接（主进程菜单 → 渲染进程动作）
  useEffect(() => {
    const api = window.electronAPI as ElectronAPI & {
      onMenu?: (ch: string, cb: () => void) => () => void
    }
    if (!api.onMenu) return
    const offs = [
      api.onMenu('menu:quick-open', () => setPaletteMode('quick')),
      api.onMenu('menu:command-palette', () => setPaletteMode('command')),
      api.onMenu('menu:toggle-focus', () =>
        updateSettings({ enableFocusMode: !settingsRef.current.enableFocusMode })
      ),
      api.onMenu('menu:toggle-typewriter', () =>
        updateSettings({ enableTypewriterMode: !settingsRef.current.enableTypewriterMode })
      ),
      api.onMenu('menu:present', () => {
        const md = selectedDoc?.content ?? selectedNote?.content
        if (md) setPresentingContent(md)
      }),
      api.onMenu('menu:import-external', () => {
        void handleImportExternal(view === 'knowledge-base' ? selectedKbId : null)
      })
    ]
    return () => offs.forEach((o) => o())
  }, [updateSettings, selectedDoc, selectedNote, view, selectedKbId])

  // REQ-110：打开 Note / KB Doc 时记录最近项
  const recordOpen = (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => {
    void window.electronAPI.recordRecentItem(item)
  }
  useEffect(() => {
    if (selectedNote) recordOpen({ kind: 'note', id: selectedNote.id, title: selectedNote.title })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNoteId])
  useEffect(() => {
    if (selectedDoc)
      recordOpen({ kind: 'kbDoc', id: selectedDoc.id, kbId: selectedDoc.kbId, title: selectedDoc.name })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocId])

  // REQ-117：多窗口 — 通过 URL 参数 openKind/openId 自动定位目标
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const kind = params.get('openKind') as 'note' | 'kbDoc' | null
    const id = params.get('openId')
    if (!kind || !id) return
    if (kind === 'note') {
      setSelectedNoteId(id)
    } else {
      const kbId = params.get('openKbId')
      if (kbId) {
        setSelectedKbId(kbId)
        setSelectedDocId(id)
        setView('knowledge-base')
      }
    }
  }, [])

  // REQ-120：外部文件夹挂载成功后刷新知识库列表
  useEffect(() => {
    const off = window.electronAPI.onExternalKbChanged(() => {
      void refreshKbs()
      if (selectedKbId) void refreshDocs()
    })
    return off
  }, [refreshKbs, refreshDocs, selectedKbId])

  // REQ-108 命令面板命令列表
  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: 'quick-open',
        label: '快速打开文件',
        keywords: ['quick', 'open', 'p', '文件'],
        group: '导航',
        run: () => setPaletteMode('quick')
      },
      {
        id: 'global-search',
        label: '全文搜索',
        keywords: ['search', '搜索', '查找'],
        group: '导航',
        run: () => setPaletteMode('search')
      },
      {
        id: 'toggle-focus',
        label: '切换 Focus 模式',
        keywords: ['focus', '专注'],
        group: '视图',
        run: () => updateSettings({ enableFocusMode: !settingsRef.current.enableFocusMode })
      },
      {
        id: 'toggle-typewriter',
        label: '切换打字机模式',
        keywords: ['typewriter', '打字机'],
        group: '视图',
        run: () =>
          updateSettings({ enableTypewriterMode: !settingsRef.current.enableTypewriterMode })
      },
      {
        id: 'toggle-theme',
        label: '切换暗色模式',
        keywords: ['theme', 'dark', '主题', '暗色'],
        group: '视图',
        run: () => updateSettings({ theme: settingsRef.current.theme === 'dark' ? 'light' : 'dark' })
      },
      {
        id: 'open-settings',
        label: '打开设置',
        keywords: ['settings', '设置', 'preferences'],
        group: '应用',
        run: () => setShowSettings(true)
      },
      {
        id: 'lock-now',
        label: '立即锁屏',
        keywords: ['lock', '锁屏', '密码'],
        group: '应用',
        run: () => lockNow()
      },
      {
        id: 'open-trash',
        label: '打开回收站',
        keywords: ['trash', '回收站'],
        group: '应用',
        run: () => setShowTrash(true)
      },
      {
        id: 'open-assets',
        label: '资源管理',
        keywords: ['assets', '资源', '图片'],
        group: '应用',
        run: () => setShowAssets(true)
      },
      {
        id: 'new-note',
        label: '新建小记',
        keywords: ['new', 'note', '新建', '笔记', '小记'],
        group: '创建',
        run: () => setShowCreateNote(true)
      },
      {
        id: 'new-kb',
        label: '新建知识库',
        keywords: ['new', 'kb', '知识库'],
        group: '创建',
        run: () => setShowCreateKb(true)
      },
      {
        id: 'present',
        label: '进入演示模式（当前文档）',
        keywords: ['present', '演示', '幻灯片'],
        group: '视图',
        run: () => {
          const md = selectedDoc?.content ?? selectedNote?.content
          if (md) setPresentingContent(md)
        }
      },
      {
        id: 'new-window',
        label: '新建窗口',
        keywords: ['window', '窗口'],
        group: '窗口',
        run: () => {
          // 复用菜单：window:new 新建空窗口
          const api = window.electronAPI as ElectronAPI & { onMenu?: unknown }
          void api
          window.electronAPI.openTargetInNewWindow({ kind: 'note', id: '' })
        }
      }
    ],
    [updateSettings, selectedDoc, selectedNote, lockNow]
  )

  // quicknote 浮窗 / 白板独立窗口：渲染期条件返回，必须放在所有 hooks 之后，
  // 保证每次渲染 hooks 调用顺序一致（React Hooks 规则）。
  if (isQuickNoteWindow) {
    return <QuickNoteWindow />
  }

  return (
    <div className="flex h-dvh w-dvw min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      {/* REQ-208 应用锁屏：覆盖在主界面之上 */}
      {locked && <LockScreen onUnlock={unlock} />}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <AppNavRail
          view={view}
          onNavigate={handleNavigate}
          onOpenSearch={() => setPaletteMode('search')}
          onOpenTrash={() => setShowTrash(true)}
          onOpenAssets={() => setShowAssets(true)}
          onOpenSettings={() => setShowSettings(true)}
          onExport={handleExport}
          onImport={handleImport}
          onImportExternal={() => handleImportExternal(null)}
        />
        <main className="min-w-0 flex-1">
          {selectedNoteId ? (
            <NoteDetail
              note={selectedNote}
              isLoading={isNoteLoading}
              groups={noteGroups}
              onChange={changeNote}
              onSave={saveNote}
              onDelete={deleteNote}
              onOpenKbDoc={handleOpenKbDoc}
              onBack={() => setSelectedNoteId(null)}
              isFavorite={selectedNote ? isFav('note', selectedNote.id) : false}
              onToggleFavorite={
                selectedNote
                  ? () =>
                      toggleFavorite({
                        kind: 'note',
                        id: selectedNote.id,
                        title: selectedNote.title || '无标题'
                      })
                  : undefined
              }
            />
          ) : view === 'dashboard' ? (
            <Dashboard
              notes={notes}
              groups={noteGroups}
              onSelectNote={handleOpenNote}
              onCreateNote={() => {
                setCreateNoteTargetGroup(null)
                setShowCreateNote(true)
              }}
              onCreateNoteInGroup={(groupId) => {
                void handleCreateNoteInGroup(groupId)
              }}
              onDeleteNote={deleteNote}
              onCreateGroup={async (name, parentId) => {
                await createNoteGroup(name, parentId)
              }}
              onUpdateGroup={async (id, name) => {
                await updateNoteGroup(id, name)
              }}
              onDeleteGroup={async (id) => {
                await deleteNoteGroup(id)
                await refreshNotes()
              }}
              isNoteFavorite={(id) => isFav('note', id)}
              onToggleNoteFavorite={(id, title) =>
                toggleFavorite({ kind: 'note', id, title: title || '无标题' })
              }
              favorites={favorites}
              onOpenFavorite={(fav) => {
                if (fav.kind === 'note') handleOpenNote(fav.id)
                else if (fav.kbId) handleOpenKbDoc(fav.kbId, fav.id)
              }}
              onRemoveFavorite={removeFavorite}
              todos={todos}
              todosLoading={isTodoLoading}
              onCreateTodo={() => setShowCreateTodo(true)}
              onToggleTodo={(id) => {
                const todo = todos.find((t) => t.id === id)
                if (todo) void toggleDone(todo)
              }}
              onEditTodo={(todo) => setEditingTodo(todo)}
              onDeleteTodo={async (id) => {
                const ok = await confirm({
                  title: '删除待办',
                  description: '确定要删除这条待办吗？',
                  confirmText: '删除',
                  danger: true
                })
                if (ok) {
                  deleteTodo(id)
                }
              }}
              onOpenTodoTarget={handleOpenTodoTarget}
              onOpenKbDoc={handleOpenKbDoc}
              onOpenSearch={() => setPaletteMode('search')}
              onCreateKb={() => setShowCreateKb(true)}
            />
          ) : selectedKbId ? (
              <KbDetail
                kb={selectedKb}
                docs={docs}
                selectedDoc={selectedDoc}
                selectedDocId={selectedDocId}
                isLoading={isKbLoading || isDocLoading}
                onSelectDoc={setSelectedDocId}
                onCreateDoc={(parentId) => {
                  // REQ-011：顶层「新建文档」走模板选择；子文档直接创建空白。
                  if (parentId) {
                    void createDoc('未命名文档', parentId)
                  } else {
                    setShowTemplatePicker(true)
                  }
                }}
                onCreateMindmapDoc={async () => {
                  if (!selectedKbId) return
                  const doc = await window.electronAPI.createKbDocWithType(
                    selectedKbId,
                    '未命名思维导图',
                    'mindmap'
                  )
                  if (doc) {
                    await refreshDocs()
                    setSelectedDocId(doc.id)
                  }
                }}
                onChangeDoc={changeDoc}
                onSaveDoc={saveDoc}
                onDeleteDoc={deleteDoc}
                onMoveDoc={moveDoc}
                onDeleteDocCascade={async (id) => {
                  const ok = await confirm({
                    title: '删除文档',
                    description: '该文档包含子文档，将一并删除其所有子孙文档。确定继续吗？',
                    confirmText: '删除',
                    danger: true
                  })
                  if (ok) {
                    await deleteDocCascade(id)
                  }
                }}
                onOpenNote={handleOpenNote}
                onAnnotationsMutation={refreshDocs}
                onPresent={(content) => setPresentingContent(content)}
                isFavorite={(id) => isFav('kbDoc', id)}
                onToggleFavorite={(id, title) =>
                  toggleFavorite({ kind: 'kbDoc', id, kbId: selectedKbId ?? undefined, title })
                }
                onBackToKbGrid={() => {
                  setSelectedKbId(null)
                  setSelectedDocId(null)
                }}
              />
          ) : (
            <KbGridPage
              kbs={kbs}
              docCounts={docCounts}
              onSelect={setSelectedKbId}
              onCreate={() => setShowCreateKb(true)}
              onDelete={deleteKb}
              onExportKb={(kbId) => {
                const kb = kbs.find((k) => k.id === kbId)
                setExportKbTarget({ id: kbId, name: kb?.name ?? '知识库' })
              }}
              onMountExternal={() => window.electronAPI.triggerOpenExternalFolder()}
            />
          )}
        </main>
      </div>

      {showCreateNote && (
        <CreateNoteDialog
          groups={noteGroups}
          defaultGroupId={createNoteTargetGroup}
          onClose={() => setShowCreateNote(false)}
          onCreate={handleCreateNote}
        />
      )}

      {showCreateKb && (
        <CreateKbDialog
          onClose={() => setShowCreateKb(false)}
          onCreate={handleCreateKb}
          onMountExternal={async () => {
            // 通过主进程弹出文件夹选择并挂载为外部知识库（渲染进程无法直接调 dialog）。
            // 主进程挂载成功后会发送 externalKb:changed 通知刷新。
            window.electronAPI.triggerOpenExternalFolder()
          }}
        />
      )}

      {showCreateTodo && (
        <CreateTodoDialog
          onClose={() => setShowCreateTodo(false)}
          onCreate={handleCreateTodo}
        />
      )}

      {editingTodo && (
        <TodoEditorDialog
          todo={editingTodo}
          onClose={() => setEditingTodo(null)}
          onSave={async (updated) => {
            await saveTodo(updated)
            setEditingTodo(null)
          }}
        />
      )}

      {/* 三合一搜索浮层：全文搜索 / 快速打开 / 命令面板 */}
      <GlobalSearch
        open={paletteMode !== null}
        mode={paletteMode ?? 'search'}
        onClose={() => setPaletteMode(null)}
        onSelect={handleSearchSelect}
        commands={commands}
        notes={notes}
        kbs={kbs}
      />

      {showTemplatePicker && selectedKbId && (
        <TemplatePickerDialog
          onClose={() => setShowTemplatePicker(false)}
          onSelect={async (content) => {
            setShowTemplatePicker(false)
            const doc = await createDoc('未命名文档', null)
            if (doc && content) {
              await saveDoc({ ...doc, content })
            }
          }}
        />
      )}

      {showTrash && (
        <TrashPanel
          onClose={() => setShowTrash(false)}
          onRestored={() => {
            refreshNotes()
            refreshKbs()
          }}
        />
      )}

      {showAssets && <AssetManagerPanel onClose={() => setShowAssets(false)} />}

      {showSettings && <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />}

      {presentingContent && (
        <PresentationMode
          content={presentingContent}
          onClose={() => setPresentingContent(null)}
        />
      )}

      <ImportExternalDialog
        result={importExternalResult}
        onClose={() => setImportExternalResult(null)}
      />

      <ExportKbDialog
        open={!!exportKbTarget}
        kbId={exportKbTarget?.id ?? null}
        kbName={exportKbTarget?.name ?? ''}
        onClose={() => setExportKbTarget(null)}
      />
    </div>
  )
}

export default function AppRoot() {
  return (
    <ToastProvider>
      <ConfirmDialogProvider>
        <App />
      </ConfirmDialogProvider>
    </ToastProvider>
  )
}
