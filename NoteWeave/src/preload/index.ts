import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  AssetEntry,
  AssetItem,
  DocType,
  ExportResult,
  HistorySummary,
  HistoryItem,
  ImportResult,
  ImportExternalResult,
  KbDocAnnotation,
  KbDocComment,
  KnowledgeBase,
  KnowledgeBaseDoc,
  KnowledgeBaseDocSummary,
  KnowledgeBaseSummary,
  LintIssue,
  MindmapData,
  Note,
  NoteGroup,
  NoteSummary,
  OpenTarget,
  PinnedItem,
  RecentItem,
  SearchResult,
  SearchHitType,
  TemplateDoc,
  ThemeDoc,
  ThemeSummary,
  Todo,
  TodoTargetType,
  TrashSummary,
  Whiteboard
} from '../shared/types'

contextBridge.exposeInMainWorld('electronAPI', {
  // Notes
  listNotes: (): Promise<NoteSummary[]> => ipcRenderer.invoke('notes:list'),
  getNote: (id: string): Promise<Note | null> => ipcRenderer.invoke('notes:get', id),
  createNote: (groupId?: string | null): Promise<Note> =>
    ipcRenderer.invoke('notes:create', groupId ?? null),
  saveNote: (note: Note): Promise<Note> => ipcRenderer.invoke('notes:save', note),
  deleteNote: (id: string): Promise<boolean> => ipcRenderer.invoke('notes:delete', id),
  onMenuSave: (callback: () => void) => {
    const handler = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('menu:save', handler)
    return () => ipcRenderer.off('menu:save', handler)
  },
  onMenuImportComplete: (callback: () => void) => {
    const handler = (_event: IpcRendererEvent) => callback()
    ipcRenderer.on('menu:import-complete', handler)
    return () => ipcRenderer.off('menu:import-complete', handler)
  },
  // REQ-108/109/116/107 通用菜单事件订阅（主进程 menu:* 单向消息）
  onMenu: (channel: string, callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  },

  // Note groups (two-level classification)
  listNoteGroups: (): Promise<NoteGroup[]> => ipcRenderer.invoke('noteGroup:list'),
  createNoteGroup: (name: string, parentId: string | null): Promise<NoteGroup> =>
    ipcRenderer.invoke('noteGroup:create', name, parentId),
  updateNoteGroup: (id: string, name: string): Promise<NoteGroup> =>
    ipcRenderer.invoke('noteGroup:update', id, name),
  deleteNoteGroup: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('noteGroup:delete', id),

  // Knowledge bases
  listKnowledgeBases: (): Promise<KnowledgeBaseSummary[]> => ipcRenderer.invoke('kb:list'),
  getKnowledgeBase: (id: string): Promise<KnowledgeBase | null> => ipcRenderer.invoke('kb:get', id),
  createKnowledgeBase: (name: string, category: string): Promise<KnowledgeBase> =>
    ipcRenderer.invoke('kb:create', name, category),
  updateKnowledgeBase: (kb: KnowledgeBase): Promise<KnowledgeBase> =>
    ipcRenderer.invoke('kb:update', kb),
  deleteKnowledgeBase: (id: string): Promise<boolean> => ipcRenderer.invoke('kb:delete', id),

  // Knowledge base documents
  listKbDocs: (kbId: string): Promise<KnowledgeBaseDocSummary[]> => ipcRenderer.invoke('kbDoc:list', kbId),
  getKbDoc: (kbId: string, docId: string): Promise<KnowledgeBaseDoc | null> =>
    ipcRenderer.invoke('kbDoc:get', kbId, docId),
  createKbDoc: (kbId: string, name: string, parentId?: string | null): Promise<KnowledgeBaseDoc> =>
    ipcRenderer.invoke('kbDoc:create', kbId, name, parentId ?? null),
  saveKbDoc: (doc: KnowledgeBaseDoc): Promise<KnowledgeBaseDoc> =>
    ipcRenderer.invoke('kbDoc:save', doc),
  deleteKbDoc: (kbId: string, docId: string): Promise<boolean> =>
    ipcRenderer.invoke('kbDoc:delete', kbId, docId),

  // Knowledge base document annotations
  listAnnotations: (kbId: string, docId: string): Promise<KbDocAnnotation[]> =>
    ipcRenderer.invoke('annotation:list', kbId, docId),
  createAnnotation: (
    kbId: string,
    docId: string,
    text: string,
    startOffset: number,
    endOffset: number,
    content: string
  ): Promise<KbDocAnnotation> =>
    ipcRenderer.invoke('annotation:create', kbId, docId, text, startOffset, endOffset, content),
  updateAnnotation: (annotation: KbDocAnnotation): Promise<KbDocAnnotation> =>
    ipcRenderer.invoke('annotation:update', annotation),
  deleteAnnotation: (kbId: string, docId: string, id: string): Promise<boolean> =>
    ipcRenderer.invoke('annotation:delete', kbId, docId, id),

  // Links between notes and KB docs
  addLink: (noteId: string, kbDocId: string): Promise<void> => ipcRenderer.invoke('link:add', noteId, kbDocId),
  removeLink: (noteId: string, kbDocId: string): Promise<void> =>
    ipcRenderer.invoke('link:remove', noteId, kbDocId),
  listLinksForNote: (noteId: string): Promise<KnowledgeBaseDocSummary[]> =>
    ipcRenderer.invoke('link:listForNote', noteId),
  listLinksForDoc: (kbDocId: string): Promise<NoteSummary[]> =>
    ipcRenderer.invoke('link:listForDoc', kbDocId),

  // Import / Export
  exportAllData: (): Promise<ExportResult> => ipcRenderer.invoke('data:export'),
  importData: (): Promise<ImportResult> => ipcRenderer.invoke('data:import'),
  getDataDir: (): Promise<string> => ipcRenderer.invoke('data:getDir'),
  openDataDir: (): Promise<boolean> => ipcRenderer.invoke('data:openDir'),
  importExternalFiles: (kbId: string | null): Promise<ImportExternalResult> =>
    ipcRenderer.invoke('data:importExternal', kbId),
  exportKnowledgeBase: (
    kbId: string,
    options: {
      format: 'markdown-folder' | 'html-site' | 'zip'
      includeAnnotations?: boolean
      includeComments?: boolean
      includeHistory?: boolean
    }
  ) => ipcRenderer.invoke('kb:export', kbId, options),

  // Whiteboard
  getWhiteboard: (kbId: string, docId: string): Promise<Whiteboard | null> =>
    ipcRenderer.invoke('whiteboard:get', kbId, docId),
  saveWhiteboard: (whiteboard: Whiteboard): Promise<Whiteboard> =>
    ipcRenderer.invoke('whiteboard:save', whiteboard),
  deleteWhiteboard: (kbId: string, docId: string): Promise<boolean> =>
    ipcRenderer.invoke('whiteboard:delete', kbId, docId),

  // Todos
  listTodos: (): Promise<Todo[]> => ipcRenderer.invoke('todo:list'),
  getTodo: (id: string): Promise<Todo | null> => ipcRenderer.invoke('todo:get', id),
  createTodo: (
    title: string,
    detail: string,
    targetType: TodoTargetType,
    targetId: string,
    kbId?: string
  ): Promise<Todo> =>
    ipcRenderer.invoke('todo:create', title, detail, targetType, targetId, kbId),
  saveTodo: (todo: Todo): Promise<Todo> => ipcRenderer.invoke('todo:save', todo),
  deleteTodo: (id: string): Promise<boolean> => ipcRenderer.invoke('todo:delete', id),

  // Settings
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke('settings:save', settings),

  // REQ-004/016 资源（图片/附件）
  readClipboardImage: (): Promise<{ buffer: number[]; ext: string } | null> =>
    ipcRenderer.invoke('asset:readClipboardImage'),
  saveImageAsset: (
    scope: 'note' | 'kb',
    ownerId: string,
    buffer: number[],
    ext: string
  ): Promise<string> => ipcRenderer.invoke('asset:saveImage', scope, ownerId, buffer, ext),
  saveAttachmentAsset: (
    scope: 'note' | 'kb',
    ownerId: string,
    buffer: number[],
    name: string
  ): Promise<string> => ipcRenderer.invoke('asset:saveAttachment', scope, ownerId, buffer, name),
  deleteAsset: (url: string): Promise<boolean> => ipcRenderer.invoke('asset:delete', url),
  listAssets: (scope: 'note' | 'kb', ownerId: string): Promise<AssetItem[]> =>
    ipcRenderer.invoke('asset:list', scope, ownerId),
  listAllAssets: (): Promise<AssetEntry[]> => ipcRenderer.invoke('asset:listAll'),
  pruneOrphanAssets: (): Promise<number> => ipcRenderer.invoke('asset:prune'),
  writeClipboardImage: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('asset:writeClipboardImage', url),
  showAssetInFolder: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('asset:showInFolder', url),
  openImageExternally: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('asset:openImage', url),
  findExclusiveAssets: (
    target:
      | { kind: 'note'; noteId: string; content: string }
      | { kind: 'kbDoc'; kbId: string; docId: string; content: string }
  ): Promise<string[]> => ipcRenderer.invoke('asset:findExclusive', target),

  // REQ-005 全文搜索
  search: (
    keyword: string,
    options?: {
      filters?: SearchHitType[]
      dateFrom?: string
      dateTo?: string
      sortBy?: 'updatedAt' | 'relevance'
    }
  ): Promise<SearchResult[]> => ipcRenderer.invoke('search:query', keyword, options),

  // REQ-008 / REQ-112 单文档导出（含扩展格式）
  exportDoc: (
    target: { kind: 'note'; noteId: string } | { kind: 'kbDoc'; kbId: string; docId: string },
    format: 'pdf' | 'html' | 'word' | 'epub' | 'latex' | 'rtf' | 'txt' | 'opml' | 'markdown',
    options?: { includeAnnotations?: boolean; themeName?: string; usePandoc?: boolean }
  ): Promise<{ success: boolean; filePath: string | null; error?: string }> =>
    ipcRenderer.invoke('export:doc', target, format, options),

  // REQ-013 回收站
  listTrash: (): Promise<TrashSummary[]> => ipcRenderer.invoke('trash:list'),
  restoreTrash: (id: string): Promise<boolean> => ipcRenderer.invoke('trash:restore', id),
  deleteTrash: (id: string): Promise<boolean> => ipcRenderer.invoke('trash:delete', id),
  emptyTrash: (): Promise<boolean> => ipcRenderer.invoke('trash:empty'),

  // REQ-014 版本历史
  listHistory: (scope: 'note' | 'kbDoc', refId: string): Promise<HistorySummary[]> =>
    ipcRenderer.invoke('history:list', scope, refId),
  getHistory: (id: string): Promise<HistoryItem | null> =>
    ipcRenderer.invoke('history:get', id),
  saveHistorySnapshot: (scope: 'note' | 'kbDoc', refId: string, content: string): Promise<boolean> =>
    ipcRenderer.invoke('history:save', scope, refId, content),

  // REQ-011 文档模板
  listTemplates: (): Promise<TemplateDoc[]> => ipcRenderer.invoke('template:list'),
  saveTemplate: (name: string, content: string): Promise<TemplateDoc> =>
    ipcRenderer.invoke('template:save', name, content),
  deleteTemplate: (id: string): Promise<boolean> => ipcRenderer.invoke('template:delete', id),

  // REQ-006 文档层级：移动 / 重排序
  moveKbDoc: (kbId: string, docId: string, parentId: string | null, order: number): Promise<boolean> =>
    ipcRenderer.invoke('kbDoc:move', kbId, docId, parentId, order),
  reorderKbDocs: (kbId: string, orderedIds: string[]): Promise<boolean> =>
    ipcRenderer.invoke('kbDoc:reorder', kbId, orderedIds),

  // REQ-015 批注回复
  addAnnotationReply: (annotation: KbDocAnnotation, content: string): Promise<KbDocAnnotation> =>
    ipcRenderer.invoke('annotation:addReply', annotation, content),
  deleteAnnotationReply: (annotation: KbDocAnnotation, replyId: string): Promise<KbDocAnnotation> =>
    ipcRenderer.invoke('annotation:deleteReply', annotation, replyId),

  // REQ-110 最近 / 固定文件
  recordRecentItem: (item: {
    kind: 'note' | 'kbDoc'
    id: string
    kbId?: string
    title: string
  }): Promise<RecentItem[]> => ipcRenderer.invoke('recent:record', item),
  pinItem: (item: {
    kind: 'note' | 'kbDoc'
    id: string
    kbId?: string
    title: string
  }): Promise<PinnedItem[]> => ipcRenderer.invoke('recent:pin', item),
  unpinItem: (kind: 'note' | 'kbDoc', id: string): Promise<PinnedItem[]> =>
    ipcRenderer.invoke('recent:unpin', kind, id),
  recordCommandUse: (commandId: string): Promise<string[]> =>
    ipcRenderer.invoke('command:recordUse', commandId),

  // REQ-111 自定义主题
  listThemes: (): Promise<ThemeSummary[]> => ipcRenderer.invoke('theme:list'),
  getTheme: (id: string): Promise<ThemeDoc | null> => ipcRenderer.invoke('theme:get', id),
  saveTheme: (theme: {
    id?: string
    name: string
    css: string
    isDark?: boolean
  }): Promise<ThemeDoc> => ipcRenderer.invoke('theme:save', theme),
  deleteTheme: (id: string): Promise<boolean> => ipcRenderer.invoke('theme:delete', id),
  resolveThemeCss: (name: string): Promise<string | null> =>
    ipcRenderer.invoke('theme:resolveCss', name),

  // REQ-115 图表本地渲染
  checkJava: (): Promise<{ available: boolean; version?: string }> =>
    ipcRenderer.invoke('diagram:checkJava'),
  checkGraphviz: (): Promise<{ available: boolean }> => ipcRenderer.invoke('diagram:checkGraphviz'),
  renderPlantUml: (source: string): Promise<{ ok: boolean; svg?: string; error?: string }> =>
    ipcRenderer.invoke('diagram:plantuml', source),
  renderGraphviz: (source: string): Promise<{ ok: boolean; svg?: string; error?: string }> =>
    ipcRenderer.invoke('diagram:graphviz', source),

  // REQ-118 Markdown Lint
  lintMarkdown: (content: string): Promise<LintIssue[]> =>
    ipcRenderer.invoke('lint:check', content),

  // REQ-117 多窗口
  openTargetInNewWindow: (target: OpenTarget): void =>
    ipcRenderer.send('window:open-target', target),

  // REQ-119 Pandoc 检测
  detectPandoc: (): Promise<{ available: boolean; version?: string; path?: string }> =>
    ipcRenderer.invoke('pandoc:detect'),

  // REQ-120 外部文件夹知识库
  mountExternalKb: (folderPath: string, readOnly: boolean): Promise<KnowledgeBaseSummary> =>
    ipcRenderer.invoke('externalKb:mount', folderPath, readOnly),
  triggerOpenExternalFolder: (): void => ipcRenderer.send('menu:open-external-folder'),
  refreshExternalKb: (kbId: string): Promise<boolean> =>
    ipcRenderer.invoke('externalKb:refresh', kbId),
  subscribeExternalKb: (kbId: string, folderPath: string): void =>
    ipcRenderer.send('externalKb:subscribe', kbId, folderPath),
  unsubscribeExternalKb: (kbId: string): void => ipcRenderer.send('externalKb:unsubscribe', kbId),
  onExternalKbChanged: (callback: (kbId: string) => void) => {
    const handler = (_event: IpcRendererEvent, kbId: string) => callback(kbId)
    ipcRenderer.on('externalKb:changed', handler)
    return () => ipcRenderer.off('externalKb:changed', handler)
  },

  // REQ-201 收藏夹
  listFavorites: () => ipcRenderer.invoke('favorite:list'),
  addFavorite: (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) =>
    ipcRenderer.invoke('favorite:add', item),
  removeFavorite: (kind: 'note' | 'kbDoc', id: string) =>
    ipcRenderer.invoke('favorite:remove', kind, id),
  isFavorite: (kind: 'note' | 'kbDoc', id: string) =>
    ipcRenderer.invoke('favorite:is', kind, id),

  // REQ-202 @提及与反链
  listBacklinks: (kind: 'note' | 'kbDoc', id: string) =>
    ipcRenderer.invoke('backlink:list', kind, id),

  // REQ-203 段落评论与文档反馈
  listComments: (kbId: string, docId: string) =>
    ipcRenderer.invoke('comment:list', kbId, docId),
  createComment: (kbId: string, docId: string, paragraphId: string, content: string) =>
    ipcRenderer.invoke('comment:create', kbId, docId, paragraphId, content),
  updateComment: (comment: KbDocComment) => ipcRenderer.invoke('comment:update', comment),
  deleteComment: (kbId: string, docId: string, id: string) =>
    ipcRenderer.invoke('comment:delete', kbId, docId, id),
  addCommentReply: (comment: KbDocComment, content: string) =>
    ipcRenderer.invoke('comment:addReply', comment, content),
  deleteCommentReply: (comment: KbDocComment, replyId: string) =>
    ipcRenderer.invoke('comment:deleteReply', comment, replyId),
  updateCommentReply: (comment: KbDocComment, replyId: string, content: string) =>
    ipcRenderer.invoke('comment:updateReply', comment, replyId, content),

  // REQ-204 搜索历史
  recordSearchHistory: (keyword: string) =>
    ipcRenderer.invoke('search:recordHistory', keyword),
  clearSearchHistory: () => ipcRenderer.invoke('search:clearHistory'),

  // REQ-208 应用锁屏
  setAppLock: (password: string) => ipcRenderer.invoke('appLock:set', password),
  verifyAppLock: (password: string) => ipcRenderer.invoke('appLock:verify', password),
  clearAppLock: (password: string) => ipcRenderer.invoke('appLock:clear', password),

  // REQ-205 图片 OCR 搜索
  ocrImage: (assetUrl: string, force?: boolean) =>
    ipcRenderer.invoke('ocr:image', assetUrl, force),
  ocrBatch: () => ipcRenderer.invoke('ocr:batch'),

  // 扩展文档类型（mindmap）
  createKbDocWithType: (kbId: string, name: string, docType: DocType) =>
    ipcRenderer.invoke('kbDoc:createWithType', kbId, name, docType),

  // REQ-212 思维导图
  getMindmapDoc: (kbId: string, docId: string) => ipcRenderer.invoke('mindmap:get', kbId, docId),
  saveMindmapDoc: (kbId: string, docId: string, data: MindmapData) =>
    ipcRenderer.invoke('mindmap:save', kbId, docId, data),
  mindmapFromMarkdown: (kbId: string, docId: string, markdown: string) =>
    ipcRenderer.invoke('mindmap:fromMarkdown', kbId, docId, markdown),
  exportMindmapDoc: (
    kbId: string,
    docId: string,
    format: 'opml' | 'png',
    pngDataUrl?: string
  ) => ipcRenderer.invoke('mindmap:export', kbId, docId, format, pngDataUrl),

  // REQ-220 快速小记（极简浮窗专用）
  quickNoteSave: (text: string) =>
    ipcRenderer.invoke('quickNote:save', text),
  quickNoteHide: () => ipcRenderer.send('quickNote:hide'),
  setQuickNoteShortcut: (accelerator: string) =>
    ipcRenderer.send('settings:quickNoteShortcut', accelerator),

  // REQ-219 本地 HTTP API
  getLocalApiStatus: (): Promise<{ running: boolean; port?: number; baseUrl?: string }> =>
    ipcRenderer.invoke('localApi:status'),
  regenerateLocalApiToken: (): Promise<string> => ipcRenderer.invoke('localApi:regenToken'),
  notifyLocalApiChanged: () => ipcRenderer.send('settings:localApiChanged'),

  // REQ-216 Web 剪藏
  getWebClipBookmarklet: (): Promise<string> => ipcRenderer.invoke('webClip:bookmarklet'),

  // REQ-215 本地 AI（Ollama）
  ollamaCheck: (url: string) =>
    ipcRenderer.invoke('ollama:check', url),
  ollamaGenerate: (model: string, prompt: string, options?: { temperature?: number }) =>
    ipcRenderer.invoke('ollama:generate', model, prompt, options),

  // REQ-224 白板框架导出 PDF
  exportWhiteboardFramesPdf: (kbId: string, docId: string, framesSvgs: string[]) =>
    ipcRenderer.invoke('whiteboard:exportFramesPdf', kbId, docId, framesSvgs),

  // REQ-225 白板模板库
  listWbTemplates: () => ipcRenderer.invoke('wbTemplate:list'),
  saveWbTemplate: (name: string, elements: unknown[], frames?: unknown[]) =>
    ipcRenderer.invoke('wbTemplate:save', name, elements, frames),
  deleteWbTemplate: (id: string) => ipcRenderer.invoke('wbTemplate:delete', id),

  // REQ-228 白板导出
  exportWhiteboard: (
    whiteboard: unknown,
    format: 'png' | 'svg' | 'markdown',
    pngDataUrl?: string
  ) => ipcRenderer.invoke('whiteboard:export', whiteboard, format, pngDataUrl)
})
