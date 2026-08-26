export interface Note {
  id: string
  title: string
  summary: string
  content: string
  createdAt: string
  updatedAt: string
  linkedKbDocIds?: string[]
  groupId?: string | null // 所属提示任务分组（二级分类），null/缺省=未分类
  tags?: string[] // REQ-012 标签
  locked?: boolean // REQ-207 文档只读锁定
  feedback?: string | null // REQ-203 文档反馈
}

export interface NoteSummary {
  id: string
  title: string
  summary: string
  updatedAt: string
  groupId?: string | null
  tags?: string[]
  locked?: boolean
}

// 提示任务分组（两级分类）。
// parentId === null 表示一级分组；parentId 指向某个一级分组则表示二级分组。
// 二级分组的 parentId 必须指向一级分组，不允许更深嵌套。
export interface NoteGroup {
  id: string
  name: string
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeBase {
  id: string
  name: string
  category: string
  createdAt: string
  updatedAt: string
  source?: 'internal' | 'external' // REQ-120 内部 / 外部文件夹挂载
  externalPath?: string | null // REQ-120 外部知识库根目录绝对路径
  externalReadOnly?: boolean // REQ-120 外部知识库是否只读
}

export interface KnowledgeBaseSummary {
  id: string
  name: string
  category: string
  updatedAt: string
  source?: 'internal' | 'external'
}

export interface KnowledgeBaseDoc {
  id: string
  kbId: string
  name: string
  content: string
  createdAt: string
  updatedAt: string
  linkedNoteIds?: string[]
  parentId?: string | null // REQ-006 层级目录，null=顶层
  order?: number // REQ-006 同级排序
  tags?: string[] // REQ-012 标签
  locked?: boolean // REQ-207 文档只读锁定
  feedback?: string | null // REQ-203 文档反馈
  docType?: DocType // REQ-211~214 文档类型
}

// REQ-211~214 文档类型。默认 markdown（普通 Markdown 文档）。
// mindmap 为新引入的独立文档类型。
export type DocType = 'markdown' | 'mindmap'

// REQ-212 思维导图节点树
export interface MindmapNode {
  id: string
  text: string
  children: MindmapNode[]
  collapsed?: boolean // 折叠子节点
}

export interface MindmapData {
  root: MindmapNode
}

export interface KnowledgeBaseDocSummary {
  id: string
  kbId: string
  name: string
  createdAt: string
  updatedAt: string
  linkedNoteIds?: string[]
  annotationCount?: number
  parentId?: string | null
  order?: number
  tags?: string[]
  locked?: boolean
  feedback?: string | null
  docType?: DocType
}

export interface KbDocAnnotation {
  id: string
  kbId: string
  docId: string
  text: string // 选中的原文片段
  startOffset: number // 在 doc.content 中的起始字符偏移
  endOffset: number // 在 doc.content 中的结束字符偏移
  content: string // 用户填写的批注文字
  replies?: AnnotationReply[] // REQ-015 回复列表
  createdAt: string
  updatedAt: string
}

// REQ-015 批注回复（讨论流）。本地应用无作者概念，author 暂留作占位/未来扩展。
export interface AnnotationReply {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

// 待办关联的目标对象类型：
// - note：首页提示任务（Note）
// - kbDoc：知识库文档（KnowledgeBaseDoc）
// 白板便签 / 段落引用卡片当前已下线，暂不作为可关联目标。
export type TodoTargetType = 'note' | 'kbDoc'

export interface Todo {
  id: string
  title: string // 标题（必填，空值兜底为「未命名待办」）
  detail: string // 详情/备注（选填，可为空串）
  done: boolean // 完成状态
  targetType: TodoTargetType // 关联对象类型
  targetId: string // 关联对象 id（noteId 或 docId）；空串表示无关联
  kbId?: string // 当 targetType === 'kbDoc' 时，所属知识库 id（便于直接跳转，避免跨域查找）
  createdAt: string
  updatedAt: string
}

export interface ExportResult {
  success: boolean
  filePath: string | null
  counts?: {
    notes: number
    knowledgeBases: number
    kbDocs: number
    whiteboards: number
    annotations: number
    todos?: number
    /** 版本历史快照数 */
    historySnapshots?: number
    /** 回收站条目数 */
    trashItems?: number
    /** 用户自定义模板数（含白板模板） */
    templates?: number
    /** 用户自定义主题数 */
    themes?: number
  }
  error?: string
}

export interface ImportResult {
  success: boolean
  counts?: {
    notes: number
    knowledgeBases: number
    kbDocs: number
    whiteboards: number
    annotations: number
    todos?: number
    /** 版本历史快照数 */
    historySnapshots?: number
    /** 回收站条目数 */
    trashItems?: number
    /** 用户自定义模板数（含白板模板） */
    templates?: number
    /** 用户自定义主题数 */
    themes?: number
  }
  errors?: string[]
  error?: string
}

// REQ-209 批量导入外部格式（.docx/.html/.md/.txt/Notion ZIP）的单文件结果
export interface ImportedDoc {
  name: string
  content: string // Markdown
  sourceType: 'docx' | 'html' | 'md' | 'txt' | 'notion'
}

// REQ-209 批量导入报告
export interface ImportExternalResult {
  success: boolean
  /** 目标知识库 id（导入时选择；为空表示创建到默认/新知识库） */
  kbId?: string
  /** 成功导入的文档名 */
  imported: string[]
  /** 失败的文件及原因 */
  failed: { file: string; reason: string }[]
  /** 跳过的图片（无法获取/解码） */
  skippedImages: string[]
  error?: string
}

// REQ-221~230 白板（无限画布）。元素以 {x, y} 像素坐标存储，坐标系原点为画布左上角。
// frames 为分页演示用的框架（REQ-224，本批次预留结构）。
export interface Whiteboard {
  kbId: string
  docId: string
  elements: WhiteboardElement[]
  frames?: WhiteboardFrame[]
  scale: number
  // REQ-221 画布平移偏移（屏幕坐标，像素）
  offsetX?: number
  offsetY?: number
  // REQ-221 画布背景模式
  background?: 'dot' | 'grid' | 'blank'
  createdAt: string
  updatedAt: string
}

// REQ-222 白板元素联合类型
export type WhiteboardElement =
  | WhiteboardStickyNote
  | WhiteboardShape
  | WhiteboardConnector
  | WhiteboardText
  | WhiteboardContentCard
  | WhiteboardFreehand

export interface BaseWhiteboardElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  locked?: boolean
  zIndex: number
  createdAt: string
  updatedAt: string
  /** REQ-226 优先级标记（P0/P1/P2 或 high/medium/low） */
  priority?: 'high' | 'medium' | 'low'
  /** REQ-221/P1：元素成组 id（同组元素一起移动） */
  groupId?: string
}

// REQ-222 便签
export interface WhiteboardStickyNote extends BaseWhiteboardElement {
  type: 'sticky'
  text: string
  color: string
  fontSize?: number
}

// REQ-222 形状
export interface WhiteboardShape extends BaseWhiteboardElement {
  type: 'shape'
  shape: 'rect' | 'rounded-rect' | 'circle' | 'diamond' | 'arrow'
  fill?: string
  stroke?: string
  strokeWidth?: number
  text?: string
}

// REQ-222 连线
export interface WhiteboardConnector {
  id: string
  type: 'connector'
  from: { elementId: string; anchor: AnchorName }
  to: { elementId: string; anchor: AnchorName }
  path: 'straight' | 'orthogonal' | 'bezier'
  arrowStart?: boolean
  arrowEnd?: boolean
  color?: string
  strokeWidth?: number
  /** REQ-221/P1：连线文本标签 */
  label?: string
  zIndex: number
  createdAt: string
  updatedAt: string
}

// 锚点名：元素四条边的中点
export type AnchorName = 'top' | 'right' | 'bottom' | 'left'

// REQ-222 独立文本
export interface WhiteboardText extends BaseWhiteboardElement {
  type: 'text'
  text: string
  fontSize?: number
  color?: string
}

// REQ-223 内容卡片（引用 Note / KB Doc / 图片 / 附件 / URL）；本批次预留结构
export interface WhiteboardContentCard extends BaseWhiteboardElement {
  type: 'content'
  targetKind: 'note' | 'kbDoc' | 'image' | 'attachment' | 'url'
  targetId?: string
  kbId?: string // targetKind=kbDoc 时所属知识库（用于跳转）
  url?: string
  title: string
  summary?: string
  previewUrl?: string
  invalid?: boolean
}

// REQ-227 手绘涂鸦（本批次预留结构）
export interface WhiteboardFreehand {
  id: string
  type: 'freehand'
  points: { x: number; y: number; pressure?: number }[]
  color: string
  strokeWidth: number
  style: 'rough' | 'smooth'
  zIndex: number
  createdAt: string
  updatedAt: string
}

// REQ-224 框架（分页演示用，本批次预留结构）
export interface WhiteboardFrame {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  order: number
}

// 编辑器模式（REQ-001）：
// - wysiwyg：单栏所见即所得（Milkdown）
// - instant：即时渲染（输入 Markdown 标记后立即渲染，基于 MDEditor live 预览）
// - source：纯源码编辑（基于 MDEditor edit）
// - preview：只读预览（react-markdown 渲染；KB Doc 下支持批注高亮）
export type EditorMode = 'wysiwyg' | 'instant' | 'source' | 'preview'

// 应用设置（REQ-001 模式持久化 / REQ-010 暗色 / REQ-014 历史版本上限等）。
// 持久化到 {userData}/settings.json；缺失字段由 getSettings 用默认值回填。
export interface AppSettings {
  theme: 'light' | 'dark' | 'system' | string // REQ-111 支持自定义主题名
  defaultEditorMode: EditorMode
  autoSaveDebounceMs: number
  maxHistoryVersions: number
  enableLineNumbers: boolean
  enableSpellCheck: boolean // REQ-113 拼写检查
  enableAutoPair: boolean // REQ-114 自动配对
  enableFocusMode: boolean // REQ-107 Focus 模式（会话级，亦持久化以便记忆）
  enableTypewriterMode: boolean // REQ-107 打字机模式
  enableLint: boolean // REQ-118 Markdown Lint
  enablePlantUMLServer: boolean // REQ-115 启用本地 PlantUML 服务
  diagramBackend: 'local' // REQ-115 图表后端（保留扩展位）
  pandocPath?: string | null // REQ-119 自定义 pandoc 可执行路径
  pandocArgs?: string[] // REQ-119 pandoc 额外参数
  pinnedItems: PinnedItem[] // REQ-110 固定项
  recentItems: RecentItem[] // REQ-110 最近项
  commandHistory?: string[] // REQ-108 命令面板最近使用
  favorites?: FavoriteItem[] // REQ-201 收藏夹
  appLock?: AppLockConfig | null // REQ-208 应用锁屏
  searchHistory?: SearchHistoryItem[] // REQ-204 搜索历史
  ocrEnabled?: boolean // REQ-205 图片 OCR 搜索开关
  quickNote?: {
    enabled: boolean
    shortcut: string // 默认 'Ctrl+Shift+N'
    defaultGroupId: string | null // 保存到的默认 Note 分组
  }
  localApi?: {
    enabled: boolean
    port: number // 默认随机端口（0 = 随机）
    token: string // 认证 Token
  }
  webClip?: {
    enabled: boolean // 默认 false（需开启本地 API 才能接收）
    defaultGroupId: string | null // 剪藏保存到的默认 Note 分组
  }
  ollama?: {
    enabled: boolean
    url: string // 默认 http://127.0.0.1:11434
    model: string // 默认模型
  }
}

// REQ-201 收藏项（与固定项语义不同：收藏是轻量的「标记常用」，固定是显式置顶）
export interface FavoriteItem {
  id: string
  kind: 'note' | 'kbDoc'
  kbId?: string
  title: string
  favoritedAt: string
}

// REQ-208 应用锁屏配置。密码以 PBKDF2 哈希存储，绝不保存明文。
export interface AppLockConfig {
  enabled: boolean
  passwordHash: string
  salt: string
  algorithm?: 'pbkdf2' // 留作扩展位，当前固定为 pbkdf2
  iterations?: number
}

// REQ-203 段落评论。
// paragraphId 通过标题/段落锚点或内容哈希生成，尽量保持稳定。
export interface KbDocComment {
  id: string
  kbId: string
  docId: string
  paragraphId: string
  content: string
  replies?: CommentReply[]
  createdAt: string
  updatedAt: string
}

export interface CommentReply {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

// REQ-204 搜索历史条目。
export interface SearchHistoryItem {
  keyword: string
  searchedAt: string
}

// REQ-202 文档提及（@提及）解析结果。
// 提及语法：[[type:id|标题]]（type 为 note / kbDoc）。
export interface DocMention {
  kind: 'note' | 'kbDoc'
  id: string
  title?: string
}

// REQ-202 反链条目：引用了目标文档的另一篇文档。
export interface Backlink {
  // 引用方类型与 id
  kind: 'note' | 'kbDoc'
  id: string
  kbId?: string
  title: string
  // 命中的提及原始文本（[[note:xxx|标题]]）
  snippet: string
  updatedAt: string
}

// REQ-110 固定文件项（Note / KB Doc）
export interface PinnedItem {
  id: string
  kind: 'note' | 'kbDoc'
  kbId?: string // kind=kbDoc 时所属知识库
  title: string
  pinnedAt: string
}

// REQ-110 最近文件项
export interface RecentItem {
  id: string
  kind: 'note' | 'kbDoc'
  kbId?: string
  title: string
  openedAt: string
}

// REQ-111 用户自定义主题摘要（不含 CSS 正文，列表用）
export interface ThemeSummary {
  id: string
  name: string
  builtin: boolean
  isDark?: boolean
}

// REQ-111 主题（含 CSS 正文）
export interface ThemeDoc extends ThemeSummary {
  css: string
  createdAt?: string
  updatedAt?: string
}

// REQ-118 Markdown Lint 单条问题
export interface LintIssue {
  line: number // 1-based
  column: number // 1-based
  rule: string
  message: string
}

// REQ-117 多窗口打开目标
export interface OpenTarget {
  kind: 'note' | 'kbDoc'
  id: string
  kbId?: string
}

// REQ-013 回收站条目。删除 Note / KB Doc / 知识库时先转入回收站，
// 记录原始类型、删除时间与原始数据（含内容/批注等），便于整条恢复。
export interface TrashItem {
  id: string // 回收站条目 id（独立于原 id）
  kind: 'note' | 'kbDoc' | 'knowledgeBase'
  originalId: string
  kbId?: string // kind=kbDoc/knowledgeBase 时所属知识库
  parentId?: string | null
  name: string // 显示名（标题/文档名/知识库名）
  payload: unknown // 原始序列化数据（Note/KnowledgeBaseDoc 等 + 关联批注/白板）
  deletedAt: string
}

export interface TrashSummary {
  id: string
  kind: 'note' | 'kbDoc' | 'knowledgeBase'
  originalId: string
  kbId?: string
  name: string
  deletedAt: string
}

// REQ-014 版本历史条目。每次内容变化保存时写入一个快照。
export interface HistoryItem {
  id: string
  scope: 'note' | 'kbDoc'
  refId: string // noteId 或 docId
  content: string
  savedAt: string
}

// REQ-014 历史摘要（列表用，不含完整 content，避免一次性加载大量内容）。
export interface HistorySummary {
  id: string
  scope: 'note' | 'kbDoc'
  refId: string
  savedAt: string
  length: number
}

// REQ-005/204/205 搜索结果条目。命中可能来自 Note / KB Doc / Todo / Annotation / Comment / Image(OCR)。
export type SearchHitType = 'note' | 'kbDoc' | 'todo' | 'annotation' | 'comment' | 'image'

export type SearchSort = 'updatedAt' | 'relevance'

export interface SearchOptions {
  filters?: SearchHitType[]
  dateFrom?: string // ISO，含；updatedAt >= dateFrom
  dateTo?: string // ISO，含；updatedAt <= dateTo
  sortBy?: SearchSort
  // REQ-204 高级筛选
  kbIds?: string[] // 限定所属知识库（仅对 kbDoc/annotation/comment 生效）
  tags?: string[] // 限定包含任一标签（note 与 kbDoc）
}

export interface SearchResult {
  type: SearchHitType
  id: string
  title: string
  snippet: string // 带高亮标记（用 <mark>）的匹配片段
  updatedAt?: string
  // 相关度（命中次数越多越高），用于按相关度排序
  score?: number
  // 命中的纯文本（去除 HTML 标记），供详情页滚动定位使用
  matchText?: string
  // 跳转所需的上下文
  kbId?: string
  docId?: string
}

// REQ-004/016 资源条目（图片/附件）。
export interface AssetItem {
  name: string
  url: string // noteweave-asset:// 协议地址
  size: number
  createdAt: string
}

// 资源管理面板用：带归属（scope/ownerId）的资源条目。
export interface AssetEntry extends AssetItem {
  scope: 'note' | 'kb'
  ownerId: string
}

// REQ-011 文档模板。
export interface TemplateDoc {
  id: string
  name: string
  content: string
  builtin?: boolean
  createdAt: string
  updatedAt: string
}

export interface ElectronAPI {
  // Notes
  listNotes: () => Promise<NoteSummary[]>
  getNote: (id: string) => Promise<Note | null>
  createNote: (groupId?: string | null) => Promise<Note>
  saveNote: (note: Note) => Promise<Note>
  deleteNote: (id: string) => Promise<boolean>
  onMenuSave: (callback: () => void) => () => void
  onMenuImportComplete: (callback: () => void) => () => void
  /** REQ-108/109/116/107 通用菜单事件订阅（主进程 menu:* 单向消息）。 */
  onMenu: (channel: string, callback: () => void) => () => void

  // Note groups (two-level classification)
  listNoteGroups: () => Promise<NoteGroup[]>
  createNoteGroup: (name: string, parentId: string | null) => Promise<NoteGroup>
  updateNoteGroup: (id: string, name: string) => Promise<NoteGroup>
  deleteNoteGroup: (id: string) => Promise<boolean>

  // Knowledge bases
  listKnowledgeBases: () => Promise<KnowledgeBaseSummary[]>
  getKnowledgeBase: (id: string) => Promise<KnowledgeBase | null>
  createKnowledgeBase: (name: string, category: string) => Promise<KnowledgeBase>
  updateKnowledgeBase: (kb: KnowledgeBase) => Promise<KnowledgeBase>
  deleteKnowledgeBase: (id: string) => Promise<boolean>

  // Knowledge base documents
  listKbDocs: (kbId: string) => Promise<KnowledgeBaseDocSummary[]>
  getKbDoc: (kbId: string, docId: string) => Promise<KnowledgeBaseDoc | null>
  createKbDoc: (kbId: string, name: string) => Promise<KnowledgeBaseDoc>
  saveKbDoc: (doc: KnowledgeBaseDoc) => Promise<KnowledgeBaseDoc>
  deleteKbDoc: (kbId: string, docId: string) => Promise<boolean>

  // Knowledge base document annotations
  listAnnotations: (kbId: string, docId: string) => Promise<KbDocAnnotation[]>
  createAnnotation: (
    kbId: string,
    docId: string,
    text: string,
    startOffset: number,
    endOffset: number,
    content: string
  ) => Promise<KbDocAnnotation>
  updateAnnotation: (annotation: KbDocAnnotation) => Promise<KbDocAnnotation>
  deleteAnnotation: (kbId: string, docId: string, id: string) => Promise<boolean>

  // Links between notes and KB docs
  addLink: (noteId: string, kbDocId: string) => Promise<void>
  removeLink: (noteId: string, kbDocId: string) => Promise<void>
  listLinksForNote: (noteId: string) => Promise<KnowledgeBaseDocSummary[]>
  listLinksForDoc: (kbDocId: string) => Promise<NoteSummary[]>

  // Import / Export
  exportAllData: () => Promise<ExportResult>
  importData: () => Promise<ImportResult>
  /** UE-18 设置·数据分区：获取数据目录（userData 根）路径用于展示 */
  getDataDir: () => Promise<string>
  /** UE-18 设置·数据分区：在文件管理器中打开数据目录 */
  openDataDir: () => Promise<boolean>
  /** REQ-209 批量导入外部文件（.docx/.html/.md/.txt/Notion ZIP）到指定知识库 */
  importExternalFiles: (
    kbId: string | null
  ) => Promise<ImportExternalResult>
  /** REQ-210 批量导出整个知识库（Markdown 文件夹/HTML 站点/ZIP） */
  exportKnowledgeBase: (
    kbId: string,
    options: {
      format: 'markdown-folder' | 'html-site' | 'zip'
      includeAnnotations?: boolean
      includeComments?: boolean
      includeHistory?: boolean
    }
  ) => Promise<{
    success: boolean
    outputPath: string | null
    docCount: number
    error?: string
  }>

  // Whiteboard
  getWhiteboard: (kbId: string, docId: string) => Promise<Whiteboard | null>
  saveWhiteboard: (whiteboard: Whiteboard) => Promise<Whiteboard>
  deleteWhiteboard: (kbId: string, docId: string) => Promise<boolean>

  // Todos
  listTodos: () => Promise<Todo[]>
  getTodo: (id: string) => Promise<Todo | null>
  createTodo: (
    title: string,
    detail: string,
    targetType: TodoTargetType,
    targetId: string,
    kbId?: string
  ) => Promise<Todo>
  saveTodo: (todo: Todo) => Promise<Todo>
  deleteTodo: (id: string) => Promise<boolean>

  // Settings（REQ-001 编辑器模式持久化 / REQ-010 暗色 / REQ-014 历史上限等）
  getSettings: () => Promise<AppSettings>
  saveSettings: (settings: AppSettings) => Promise<boolean>

  // REQ-004/016 资源（图片/附件）
  readClipboardImage: () => Promise<{ buffer: number[]; ext: string } | null>
  saveImageAsset: (scope: 'note' | 'kb', ownerId: string, buffer: number[], ext: string) => Promise<string>
  saveAttachmentAsset: (scope: 'note' | 'kb', ownerId: string, buffer: number[], name: string) => Promise<string>
  deleteAsset: (relativePath: string) => Promise<boolean>
  listAssets: (scope: 'note' | 'kb', ownerId: string) => Promise<AssetItem[]>
  listAllAssets: () => Promise<AssetEntry[]>
  pruneOrphanAssets: () => Promise<number>
  writeClipboardImage: (url: string) => Promise<boolean>
  showAssetInFolder: (url: string) => Promise<boolean>
  openImageExternally: (url: string) => Promise<boolean>
  findExclusiveAssets: (
    target:
      | { kind: 'note'; noteId: string; content: string }
      | { kind: 'kbDoc'; kbId: string; docId: string; content: string }
  ) => Promise<string[]>

  // REQ-005 全文搜索
  search: (keyword: string, options?: SearchOptions) => Promise<SearchResult[]>

  // REQ-008 / REQ-112 单文档导出（含扩展格式）
  exportDoc: (
    target: { kind: 'note'; noteId: string } | { kind: 'kbDoc'; kbId: string; docId: string },
    format: 'pdf' | 'html' | 'word' | 'epub' | 'latex' | 'rtf' | 'txt' | 'opml' | 'markdown',
    options?: {
      includeAnnotations?: boolean
      themeName?: string // REQ-111 导出专用主题
      usePandoc?: boolean // REQ-119 使用 Pandoc
    }
  ) => Promise<{ success: boolean; filePath: string | null; error?: string }>

  // REQ-013 回收站
  listTrash: () => Promise<TrashSummary[]>
  restoreTrash: (id: string) => Promise<boolean>
  deleteTrash: (id: string) => Promise<boolean>
  emptyTrash: () => Promise<boolean>

  // REQ-014 版本历史
  listHistory: (scope: 'note' | 'kbDoc', refId: string) => Promise<HistorySummary[]>
  getHistory: (id: string) => Promise<HistoryItem | null>
  saveHistorySnapshot: (scope: 'note' | 'kbDoc', refId: string, content: string) => Promise<boolean>

  // REQ-011 文档模板
  listTemplates: () => Promise<TemplateDoc[]>
  saveTemplate: (name: string, content: string) => Promise<TemplateDoc>
  deleteTemplate: (id: string) => Promise<boolean>

  // REQ-006 文档层级：移动文档到新父节点/排序
  moveKbDoc: (kbId: string, docId: string, parentId: string | null, order: number) => Promise<boolean>
  reorderKbDocs: (kbId: string, orderedIds: string[]) => Promise<boolean>

  // REQ-015 批注回复
  addAnnotationReply: (annotation: KbDocAnnotation, content: string) => Promise<KbDocAnnotation>
  deleteAnnotationReply: (annotation: KbDocAnnotation, replyId: string) => Promise<KbDocAnnotation>

  // REQ-110 最近 / 固定文件
  recordRecentItem: (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => Promise<RecentItem[]>
  pinItem: (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => Promise<PinnedItem[]>
  unpinItem: (kind: 'note' | 'kbDoc', id: string) => Promise<PinnedItem[]>
  recordCommandUse: (commandId: string) => Promise<string[]>

  // REQ-111 自定义主题
  listThemes: () => Promise<ThemeSummary[]>
  getTheme: (id: string) => Promise<ThemeDoc | null>
  saveTheme: (theme: { id?: string; name: string; css: string; isDark?: boolean }) => Promise<ThemeDoc>
  deleteTheme: (id: string) => Promise<boolean>
  resolveThemeCss: (name: string) => Promise<string | null>

  // REQ-115 图表本地后端
  checkJava: () => Promise<{ available: boolean; version?: string }>
  checkGraphviz: () => Promise<{ available: boolean }>
  renderPlantUml: (source: string) => Promise<{ ok: boolean; svg?: string; error?: string }>
  renderGraphviz: (source: string) => Promise<{ ok: boolean; svg?: string; error?: string }>

  // REQ-118 Markdown Lint
  lintMarkdown: (content: string) => Promise<LintIssue[]>

  // REQ-117 多窗口
  openTargetInNewWindow: (target: OpenTarget) => void

  // REQ-119 Pandoc 检测
  detectPandoc: () => Promise<{ available: boolean; version?: string; path?: string }>

  // REQ-120 外部文件夹知识库
  mountExternalKb: (folderPath: string, readOnly: boolean) => Promise<KnowledgeBaseSummary>
  triggerOpenExternalFolder: () => void
  refreshExternalKb: (kbId: string) => Promise<boolean>
  onExternalKbChanged: (callback: (kbId: string) => void) => () => void

  // REQ-201 收藏夹
  listFavorites: () => Promise<FavoriteItem[]>
  addFavorite: (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => Promise<FavoriteItem[]>
  removeFavorite: (kind: 'note' | 'kbDoc', id: string) => Promise<FavoriteItem[]>
  isFavorite: (kind: 'note' | 'kbDoc', id: string) => Promise<boolean>

  // REQ-202 @提及与反链
  listBacklinks: (kind: 'note' | 'kbDoc', id: string) => Promise<Backlink[]>

  // REQ-203 段落评论与文档反馈
  listComments: (kbId: string, docId: string) => Promise<KbDocComment[]>
  createComment: (kbId: string, docId: string, paragraphId: string, content: string) => Promise<KbDocComment>
  updateComment: (comment: KbDocComment) => Promise<KbDocComment>
  deleteComment: (kbId: string, docId: string, id: string) => Promise<boolean>
  addCommentReply: (comment: KbDocComment, content: string) => Promise<KbDocComment>
  deleteCommentReply: (comment: KbDocComment, replyId: string) => Promise<KbDocComment>
  updateCommentReply: (comment: KbDocComment, replyId: string, content: string) => Promise<KbDocComment>

  // REQ-204 搜索历史
  recordSearchHistory: (keyword: string) => Promise<SearchHistoryItem[]>
  clearSearchHistory: () => Promise<boolean>

  // REQ-208 应用锁屏
  setAppLock: (password: string) => Promise<boolean>
  verifyAppLock: (password: string) => Promise<boolean>
  clearAppLock: (password: string) => Promise<boolean>

  // REQ-205 图片 OCR 搜索
  /** 对单张图片执行 OCR（结果写入缓存）；force 表示忽略已有缓存 */
  ocrImage: (assetUrl: string, force?: boolean) => Promise<{ ok: boolean; text?: string; error?: string }>
  /** 后台批量 OCR 所有未索引图片，返回处理数量 */
  ocrBatch: () => Promise<{ processed: number; failed: number }>

  // 扩展文档类型（mindmap）
  /** 创建指定类型的新文档（docType：mindmap） */
  createKbDocWithType: (kbId: string, name: string, docType: DocType) => Promise<KnowledgeBaseDoc>

  // REQ-212 思维导图
  getMindmapDoc: (kbId: string, docId: string) => Promise<MindmapData | null>
  saveMindmapDoc: (kbId: string, docId: string, data: MindmapData) => Promise<boolean>
  /** 从 Markdown 标题结构生成思维导图（覆盖当前数据） */
  mindmapFromMarkdown: (kbId: string, docId: string, markdown: string) => Promise<boolean>
  /** 导出思维导图为 OPML / PNG（PNG 由渲染进程截图，主进程落盘） */
  exportMindmapDoc: (
    kbId: string,
    docId: string,
    format: 'opml' | 'png',
    pngDataUrl?: string
  ) => Promise<{ success: boolean; filePath: string | null; error?: string }>

  // REQ-220 快速小记（极简浮窗专用）
  quickNoteSave: (text: string) => Promise<{ ok: boolean; noteId?: string; reason?: string }>
  quickNoteHide: () => void
  /** REQ-220 更新全局小记快捷键（通知主进程重新注册） */
  setQuickNoteShortcut: (accelerator: string) => void

  // REQ-219 本地 HTTP API
  /** 获取本地 API 运行状态（实际监听端口） */
  getLocalApiStatus: () => Promise<{ running: boolean; port?: number; baseUrl?: string }>
  /** 重新生成本地 API Token（返回新 token） */
  regenerateLocalApiToken: () => Promise<string>
  /** 通知主进程设置变更，重启本地 API */
  notifyLocalApiChanged: () => void

  // REQ-216 Web 剪藏
  /** 生成书签脚本（bookmarklet）字符串，base 为本地 API 地址 */
  getWebClipBookmarklet: () => Promise<string>

  // REQ-215 本地 AI（Ollama）
  /** 测试 Ollama 连接，返回可用模型列表 */
  ollamaCheck: (url: string) => Promise<{ ok: boolean; models?: string[]; error?: string }>
  /** 调用 Ollama generate（prompt + model），返回生成文本 */
  ollamaGenerate: (
    model: string,
    prompt: string,
    options?: { temperature?: number }
  ) => Promise<{ ok: boolean; text?: string; error?: string }>

  // REQ-224 白板框架导出为 PDF（每帧一页），framesSvgs 为每帧 SVG 字符串
  exportWhiteboardFramesPdf: (
    kbId: string,
    docId: string,
    framesSvgs: string[]
  ) => Promise<{ success: boolean; filePath: string | null; error?: string }>

  // REQ-225 白板模板库
  listWbTemplates: () => Promise<unknown[]>
  saveWbTemplate: (
    name: string,
    elements: unknown[],
    frames?: unknown[]
  ) => Promise<unknown>
  deleteWbTemplate: (id: string) => Promise<boolean>

  // REQ-228 白板导出（PNG/SVG/Markdown）
  exportWhiteboard: (
    whiteboard: unknown,
    format: 'png' | 'svg' | 'markdown',
    pngDataUrl?: string
  ) => Promise<{ success: boolean; filePath: string | null; error?: string }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
