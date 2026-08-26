# 织记（NoteWeave）— AI Agent 项目指南

> 面向 AI 编程助手的项目速查。详细设计见 `docs/DESIGN.md`、`docs/IPC_API.md`、`docs/USER_GUIDE.md`。

## 1. 项目概述

织记（NoteWeave）是一款面向 Windows 的本地优先、Markdown 原生桌面笔记应用：

- 左侧 Note（小记）列表，点击进入详情编辑/预览；Note 支持分组（NoteGroup）。
- 多知识库（Knowledge Base），每库多篇 Markdown 文档（KB Doc），支持层级/子文档。
- Note 与 KB Doc 双向关联；KB Doc 支持批注、版本历史、评论、反链、收藏。
- 白板（Whiteboard）为无限画布，当前为**仅浏览模式**：查看已有便签、形状、连线、手绘、框架、内容卡片，支持平移/缩放、内容卡片跳转、框架演示与导出（详见 §11 白板裁剪说明）。
- 文档类型除 Markdown 外，还包括思维导图。
- 待办（Todo）为独立数据模块，工作台 Dashboard 聚合最近/收藏/小记/待办。
- 数据以本地 JSON / Markdown 文件持久化，无需联网。

当前版本 `1.0.0`，界面语言为简体中文。

## 2. 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面运行时 | Electron | `^35.0.0` |
| 主进程 | Node.js + TypeScript | TS `^5.8.2` |
| 渲染进程 UI | React | `^19.0.0` |
| 构建 | Vite + electron-vite | Vite `^6.2.1`、electron-vite `^3.1.0` |
| 样式 | Tailwind CSS v4 | `^4.0.12`，无 `tailwind.config.ts`，经 `@tailwindcss/vite` 接入，主题在 `src/renderer/src/index.css` |
| 编辑器（源码/即时） | `@uiw/react-md-editor` | `^4.0.5` |
| 编辑器（WYSIWYG） | Milkdown | `^7.21.2` |
| Markdown 渲染 | `react-markdown` + `remark-gfm`/`remark-math` + `rehype-katex` | — |
| 公式 | KaTeX | `^0.17.0` |
| 图表 | Mermaid / PlantUML / Graphviz（`@viz-js/viz`） | — |
| 代码高亮 | `react-syntax-highlighter` | `^15.6.6` |
| 图标 | `lucide-react` | — |
| OCR | `tesseract.js` | `^7.0.0` |
| 测试 | Vitest | `^4.1.9`（无独立配置文件，用默认约定） |
| 打包 | electron-builder | `^26.0.12` |

其他常用依赖：`jszip`（导入导出 ZIP）、`mammoth`/`turndown`（外部格式转换）、`uuid`、`clsx` + `tailwind-merge`、`markdownlint`。

## 3. 架构

标准 Electron 三层架构：

```
主进程      src/main/index.ts / ipc-handlers.ts / store.ts / export-import.ts
  │         窗口、生命周期、菜单、IPC、本地文件存储
  │ IPC invoke/handle
  ▼
预加载      src/preload/index.ts 暴露 window.electronAPI
  │
  ▼
渲染进程    src/renderer/src/*  React + Hooks 通过 electronAPI 调用主进程
```

关键入口：

- `src/main/index.ts`：应用入口，创建主窗口（尺寸按屏幕比例计算，最小 1024×700）、菜单；启动时重定向 `userData`。
- `src/main/ipc-handlers.ts`：集中注册所有 `ipcMain.handle`（约 100 个通道）。
- `src/main/store.ts`：Note / NoteGroup / KB / KB Doc / Annotation / Whiteboard / Todo / Link / 设置等本地存储。
- `src/preload/index.ts`：`contextBridge` 暴露类型化 API。
- `src/renderer/src/App.tsx`：根组件，区分主窗口/`?quicknote=1` 浮窗。

## 4. 代码组织

```
src/
├── shared/
│   ├── types.ts              # 共享类型与 ElectronAPI 接口
│   └── *-helpers.ts / ai-prompts.ts / wb-templates.ts  # 主/渲染进程共用的纯函数模块
├── main/
│   ├── index.ts              # 应用入口
│   ├── ipc-handlers.ts       # IPC 处理器注册
│   ├── store.ts              # 文件存储核心
│   ├── export-import.ts      # 数据导出/导入 ZIP
│   ├── doc-export.ts         # Markdown→PDF/HTML/Word 等
│   ├── import-external.ts    # 外部格式导入
│   ├── kb-export.ts          # 知识库批量导出
│   ├── mindmap-doc.ts        # 思维导图
│   ├── ocr.ts                # 图片 OCR
│   ├── ollama.ts             # Ollama AI
│   ├── http-api.ts           # 本地 HTTP API
│   ├── tray.ts               # 系统托盘/快捷小记
│   ├── external-kb.ts        # 外部知识库挂载
│   ├── pandoc.ts / plantuml-local.ts / diagram-render.ts  # 外部工具集成
│   └── wb-export.ts / wb-templates.ts                     # 白板导出/模板
├── preload/
│   └── index.ts              # contextBridge 暴露
└── renderer/src/
    ├── main.tsx / App.tsx / index.html / index.css
    ├── components/           # React UI 组件（约 80 个）
    ├── hooks/                # 数据/状态 Hooks
    └── lib/                  # 工具函数与 Markdown/Milkdown 插件
```

核心组件/Hook（按模块）：

- **应用骨架（语雀式）**：`AppNavRail`（左侧图标导航栏：工作台/知识库 + 搜索/资源/回收站/主题/设置；数据导入导出收进设置对话框「数据」分区，配套 `data:getDir`/`data:openDir` IPC）→ `main` 区按状态渲染：小记详情覆盖层（`NoteDetail`）/ `Dashboard`（工作台：问候 + 快捷新建 + 最近/收藏/小记/待办 Tab）/ `KbGridPage`（知识库卡片网格）/ `KbDetail`（KB 内部：目录树 + 文档区）。App 一级视图仅 `'dashboard' | 'knowledge-base'`。
- **Note（小记）**：`NoteGroupTree` / `NoteListItem` / `NoteDetail`（面包屑 + 阅读优先，`DocPageHeader`）/ `useNotes` / `useNoteGroups`
- **KB Doc**：`KbGridPage` / `KbDocTree` / `KbDocListItem` / `KbDetail` / `KbDocEditor`（阅读优先，`DocPageHeader` + 右侧大纲抽屉）/ `useKnowledgeBases` / `useKnowledgeBaseDocs`
- **待办（Todo）**：`TodoList` / `TodoPanel` / `TodoEditorDialog` / `useTodos` / `useTodosForTarget`
- **编辑器**：`NoteEditor`（Markdown 源码）/ `MilkdownEditor`（富文本 WYSIWYG，含 `SelectionBubble` 选区气泡、`SlashMenu`）/ `EditorModeSwitcher`（两档：富文本 / Markdown；阅读态由 `DocPageHeader` 的「编辑/完成」承担）
- **预览**：`NotePreview` / `AnnotatedPreview` / `markdown-plugins.tsx` / `FrontMatterCard` / `LintPanel`（markdownlint）
- **批注/评论**：`KbDocEditor` 右侧「讨论」面板（上批注 `AnnotationPanel` + 下评论 `CommentsPanel`，UI 合并、数据模型不变）/ `AnnotationContextMenu` / `useKbDocAnnotations`
- **关联**：`LinkPanel` / `LinkPanelDrawer` / `LinkSelector` / `LinkedDocsPanel` / `useLinks`
- **搜索/标签/历史/回收站/模板**：`GlobalSearch`（三合一浮层：全文搜索/快速打开/命令，mode='search'|'quick'|'command'）/ `TagInput` / `HistoryPanel` / `TrashPanel` / `TemplatePickerDialog`
- **白板**：`Whiteboard` / `WhiteboardCanvas` / `WhiteboardToolbar` / `WhiteboardElementView` / `WhiteboardMinimap` / `useWhiteboard`

## 5. 数据模型与存储

所有数据保存在 `app.getPath('userData')` 下。`userData` 在 `src/main/index.ts` 启动时（`app ready` 之前）被重定向：

- 开发模式：`<项目根目录>/dev-data/`（已被 `.gitignore` 忽略）
- 生产模式：`<exe 目录>/data/`（数据与程序同目录，便于绿色化迁移）

因此 `store.ts` 中所有路径均通过**惰性 getter**（`getNotesDir()`、`getKnowledgeBasesDir()` 等）读取，避免模块加载时路径被固化。

### 5.1 目录结构

```
{userData}/
├── notes/{id}.json
├── settings.json
├── assets/notes/{noteId}/...            # Note 图片/附件
├── assets/knowledge-bases/{kbId}/...    # KB Doc 图片/附件
├── knowledge-bases/kb-meta.json
├── knowledge-bases/{kbId}/meta.json     # KB 元数据
├── knowledge-bases/{kbId}/doc-meta.json # 文档列表元数据
├── knowledge-bases/{kbId}/{docId}.md    # Markdown 正文
├── knowledge-bases/{kbId}/{docId}.annotations.json
├── knowledge-bases/{kbId}/{docId}.whiteboard.json
├── knowledge-bases/{kbId}/{docId}.comments.json
├── knowledge-bases/{kbId}/{docId}.mindmap.json
├── templates/                           # 文档模板
├── templates/whiteboard/                # 白板模板
├── trash/trash.json
├── history/{notes,kbDocs}/{refId}/index.json
├── themes/                              # 自定义主题
├── external-kbs/{hash}/                 # 外部知识库元数据
└── ocr-cache/{key}.json
```

### 5.2 核心类型（`src/shared/types.ts`）

```typescript
interface Note {
  id: string; title: string; summary: string; content: string;
  createdAt: string; updatedAt: string;
  linkedKbDocIds?: string[]; tags?: string[];
  locked?: boolean; feedback?: string | null;
}

interface KnowledgeBase {
  id: string; name: string; category: string;
  createdAt: string; updatedAt: string;
  source?: 'internal' | 'external';
  externalPath?: string; externalReadOnly?: boolean;
}

interface KnowledgeBaseDoc {
  id: string; kbId: string; name: string; content: string;
  createdAt: string; updatedAt: string;
  linkedNoteIds?: string[]; tags?: string[];
  parentId?: string | null; order?: number;
  docType?: DocType;
  locked?: boolean; feedback?: string | null;
}

type DocType = 'markdown' | 'mindmap';
```

### 5.3 关键业务规则

- 空 Note 标题存为 `"无标题"`，空 KB Doc 名存为 `"未命名文档"`。
- `summary` 取 `content` 前 120 字符纯文本。
- 列表默认按 `updatedAt` 降序。
- 删除 Note/KB Doc/KB 时级联清理反向关联、sidecar 文件、白板、批注、评论。
- 批注按原文字符偏移记录；内容修改后尝试按 `text` 重新定位，失败则标记失效。
- 自动保存 500ms 防抖；批注为即时保存。自动保存是唯一保存路径（Typora 式，无手动保存按钮）；保存状态（unsaved/saving/saved + 完成时间）由 `lib/save-state.ts` 统一上报，StatusBar 直接订阅，组件不再维护本地保存快照。
- `annotationCount` 由 `listKbDocs` 动态读取 `.annotations.json` 注入，不持久化到 `meta.json`。

## 6. IPC 约定

- 业务调用使用 `ipcRenderer.invoke` / `ipcMain.handle`。
- 通道命名：`domain:action`。

实际注册的 domain（以 `src/main/ipc-handlers.ts` 为准）：

- 核心数据：`notes:*`、`noteGroup:*`、`kb:*`、`kbDoc:*`、`annotation:*`、`link:*`、`todo:*`
- 数据与资产：`data:export` / `data:import` / `data:importExternal`、`kb:export`、`asset:*`
- 系统功能：`settings:*`、`search:*`、`history:*`、`trash:*`、`template:*`、`theme:*`、`recent:*`、`command:*`
- 文档增强：`favorite:*`、`backlink:*`、`comment:*`、`appLock:*`、`lint:*`、`diagram:*`、`pandoc:*`、`externalKb:*`
- 扩展文档类型：`mindmap:*`
- AI 与外部：`ocr:*`、`ollama:*`、`localApi:*`、`webClip:*`、`quickNote:*`
- 白板：`whiteboard:*`、`wbTemplate:*`

单向通知（`webContents.send`，主→渲染）：

- `menu:save`、`menu:import-complete`、`menu:import-external`
- `menu:quick-open`、`menu:command-palette`、`menu:toggle-focus`、`menu:toggle-typewriter`、`menu:present`
- `externalKb:changed`

新增 IPC 时：在 `src/shared/types.ts` 添加类型 → `src/main/ipc-handlers.ts` 注册 → `src/preload/index.ts` 暴露 → Hook/组件调用。

## 7. 构建与运行

```bash
npm install
npm run dev          # 开发模式（热更新）
npm run build        # 生产构建 → out/
npm run preview      # 预览生产构建
npm test             # 运行测试（vitest run）
npm run package      # 打包当前平台
npm run package:win  # Windows NSIS 安装包 + 便携版 → dist/
```

- 路径别名：`@/...`（渲染）、`@main/...`（主进程）、`@preload/...`（预加载），在 `tsconfig.json` 与 `electron.vite.config.ts` 双侧配置。
- 打包配置在 `electron-builder.yml`：appId `com.noteweave.app`，产物为 `NoteWeave Setup 1.0.0.exe` 与 `NoteWeave-1.0.0-portable.exe`；仅保留 zh-CN / en-US 语言包。
- 首次 `npm install` 若遇 `spawn /bin/bash ENOENT`，可执行 `npm config set script-shell bash`。
- 国内打包镜像（Electron 下载超时）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run package:win
```

## 8. 代码风格

- TypeScript `strict`，模块 `ESNext`，解析 `Bundler`，JSX `react-jsx`，`noEmit`。
- 函数组件 + Hooks；Props 接口命名 `XxxProps`。
- 优先 Tailwind；复杂组合用 `cn(clsx(...), twMerge(...))`。
- 关键 CSS 类名：`markdown-body`、`annotation-highlight`、`code-block`、`mermaid-block`、`milkdown-editor`。
- Markdown 预览统一配置在 `src/renderer/src/lib/markdown-plugins.tsx`。
- 所有用户可见字符串、注释、文档使用简体中文。
- 主进程存储多采用 `try/catch` 静默忽略文件不存在或损坏。
- 纯逻辑尽量抽到 `src/shared/*-helpers.ts`，便于 Vitest 直接测试。

## 9. 测试

项目使用 Vitest（`^4.1.9`，无独立配置文件，默认约定），测试文件位于 `test/`，共 16 个：

- `lib.test.ts`：find-replace / word-count / front-matter / fuzzy
- `table-merge.test.ts`：表格合并单元格序列化
- `diagram.test.ts`：PlantUML / Graphviz 渲染
- `v13.test.ts`：mentions / search-syntax
- `whiteboard-canvas.test.ts` / `whiteboard-export.test.ts` / `whiteboard-freehand.test.ts`：白板
- `import-converters.test.ts`、`kb-export.test.ts`、`ocr-helpers.test.ts`
- `mindmap-helpers.test.ts`
- `http-api-helpers.test.ts`、`webclip-helpers.test.ts`、`ai-prompts.test.ts`、`wb-ai-prompts.test.ts`、`wb-templates.test.ts`

运行：

```bash
npm test        # 单次运行（vitest run）
npx vitest      # watch 模式
```

测试只覆盖 `src/shared` 与 `src/renderer/src/lib` 中的纯函数模块，不涉及 Electron 主进程集成。

## 10. 安全

- Context Isolation 已开启，`nodeIntegration: false`。
- 渲染进程通过 preload 暴露的 API 访问主进程，不暴露完整 `ipcRenderer`。
- `src/renderer/index.html` CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: noteweave-asset:; connect-src 'self' noteweave-asset: http://127.0.0.1:*;`。
- 自定义协议 `noteweave-asset:` 仅允许访问 `userData/assets` 目录下的文件，用于预览/编辑态加载图片与附件。
- 导入/导出使用 Electron `dialog` 选择路径。
- 导入前弹确认框并自动 ZIP 备份。
- 应用锁密码使用 `crypto.pbkdf2Sync` + `timingSafeEqual`。
- `sandbox: false` 在预加载窗口设置；引入第三方内容需额外评估。

## 11. 功能地图

以下按版本归纳已落地需求。具体实现文件以对应模块的 `store.ts`、`ipc-handlers.ts`、`components/*.tsx`、`hooks/*.ts`、`lib/*.ts`、`main/*.ts` 为准。

### v1.0 核心（REQ-001~003）

Note 管理、知识库/KB Doc 管理、双向关联、批注、白板初版、Markdown 编辑与预览、本地文件持久化、数据导入导出 ZIP。

### v1.1（REQ-004~016）

| REQ | 功能 | 关键文件 |
|-----|------|----------|
| 004 | 图片/剪贴板图片/附件 | `lib/assets.ts`、`components/ImageContextMenu` |
| 005 | 全文搜索 | `components/GlobalSearch`、`store.ts search` |
| 006 | 文档层级/子文档/树形列表 | `KbDocTree`、`useKnowledgeBaseDocs` |
| 007 | 大纲 | `lib/toc.ts`、`components/DocOutline` |
| 008 | 导出 PDF/HTML/Word | `main/doc-export.ts`、`components/ExportMenu` |
| 010 | 主题 light/dark/system | `hooks/useTheme.ts`、`index.css` |
| 011 | 文档模板 | `main/store.ts` 模板模块、`TemplatePickerDialog` |
| 012 | 标签与标签筛选 | `components/TagInput`、`TagFilterBar`、`useTagSuggestions` |
| 013 | 回收站 | `components/TrashPanel`、`store.ts` trash 模块 |
| 014 | 版本历史/对比 | `components/HistoryPanel`、`store.ts` history 模块 |
| 015 | 批注回复 | `useKbDocAnnotations`、`AnnotationPanel` |
| 016 | 附件管理 | `asset:*` IPC、删除前 `findExclusiveAssets` |

### v1.2（REQ-101~120）

| REQ | 功能 | 关键文件 |
|-----|------|----------|
| 101 | 查找替换 | `lib/find-replace.ts`、`FindReplaceBar` |
| 102 | 字数统计 | `lib/word-count.ts`、`StatusBar` |
| 105 | 表格合并单元格 | `lib/table-merge-serialize.ts`、`milkdown-table-merge.ts` |
| 106 | 扩展内联标记（高亮/下划线/上下标） | `lib/milkdown-extra-marks.ts` |
| 109 | 命令面板/快速打开/模糊匹配 | `lib/fuzzy.ts`、`GlobalSearch`（三合一浮层 search/quick/command） |
| 111 | 自定义主题 | `main/store.ts` themes、`useTheme.ts` |
| 112 | 多格式导出（MD/TXT/RTF/OPML/LaTeX/EPUB） | `main/doc-export.ts` |
| 115 | PlantUML/Graphviz 本地渲染 | `main/plantuml-local.ts`、`diagram-render.ts` |
| 119 | Pandoc 导出 | `main/pandoc.ts` |
| 120 | 外部知识库挂载 | `main/external-kb.ts` |

### v1.3（REQ-201~230）

| REQ | 功能 | 关键文件 |
|-----|------|----------|
| 201 | 收藏夹 | `hooks/useFavorites.ts`、`Dashboard` 收藏 Tab |
| 202 | @提及与反链 | `lib/mentions.ts`、`MentionSelector`；反链并入 `KbDocEditor` 底部「关联与反链」抽屉（`LinkPanelDrawer` secondarySection） |
| 203 | 页面评论（文档问答）与文档反馈 | `components/CommentsPanel`（顶层=问题、回复=回答）、`store.ts` comments |
| 204 | 高级搜索/搜索历史 | `lib/search-syntax.ts`、`GlobalSearch` |
| 205 | 图片 OCR 搜索 | `main/ocr.ts`、`SettingsDialog` |
| 207 | 文档只读锁定 | `KbDocEditor`、`NoteDetail` |
| 208 | 应用锁屏 | `hooks/useAppLock.ts`、`components/LockScreen` |
| 209 | 批量导入外部格式 | `main/import-external.ts`、`ImportExternalDialog` |
| 210 | 批量导出知识库 | `main/kb-export.ts`、`ExportKbDialog` |
| 212 | 思维导图 | `main/mindmap-doc.ts`、`components/MindmapEditor` |
| 215 | Ollama 本地 AI | `main/ollama.ts`、`hooks/useAi.ts`、`components/AiMenu` |
| 216 | Web 剪藏 | `main/http-api.ts` POST /api/clip、`webclip-helpers.ts` |
| 217 | 自动标签推荐 | `components/TagSuggestions`、`shared/ai-prompts.ts` |
| 218 | 文档翻译 | `components/TranslateDialog` |
| 219 | 本地 HTTP API | `main/http-api.ts`、`http-api-helpers.ts` |
| 220 | 系统托盘快捷小记 | `main/tray.ts`、`components/QuickNoteWindow` |
| 221 | 白板无限画布（平移/缩放/框选/复制粘贴） | `lib/whiteboard-canvas.ts`、`WhiteboardCanvas` |
| 222 | 白板元素（便签/形状/连线/文本） | `WhiteboardElementView` |
| 223 | 白板内容卡片 | `Whiteboard`、`NoteListItem`、`KbDocListItem` |
| 224 | 白板框架与分页演示/导出 PDF | `FramePresentation`、`main/wb-export.ts` |
| 225 | 白板模板库 | `shared/wb-templates.ts`、`main/wb-templates.ts` |
| 226 | 白板个人记录工具（优先级/计时器/转待办） | `WhiteboardTimerPanel`、`WhiteboardElementView` |
| 227 | 白板手绘与涂鸦 | `WhiteboardCanvas` pen/eraser、`shared/whiteboard-export.ts` |
| 228 | 白板导出 PNG/SVG/Markdown | `main/wb-export.ts`、`whiteboard-export.ts` |
| 229 | 白板与文档双向同步 | `Whiteboard`、`store.saveWhiteboard` |
| 230 | 白板 AI 辅助 | `components/WbAiMenu`、`shared/wb-ai-prompts.ts` |

> 白板 UI 已裁剪：画布工具调色板已整体移除（无选择/抓手/便签/文本/形状/框架工具），画布为**仅浏览模式**——左键拖拽平移、滚轮缩放，元素不可选中/拖动/编辑，内容卡片点击跳转保留；工具栏只剩撤销/重做、源码模式、框架演示、导出 PDF、导出（PNG/SVG/Markdown）、计时器与缩放控制。背景切换、模板入口（REQ-225 UI）、AI 菜单（REQ-230 UI）亦已移除；「展示」独立窗口功能已整体移除（含 `createWhiteboardWindow`、`whiteboard:open-window`/`close-ready`/`before-close`/`doc-updated` 通道、preload 与 `ElectronAPI` 对应条目、App.tsx 的 `?whiteboard=1` 分支），演示需求由框架演示（FramePresentation）承担。旧数据中的所有元素（含手绘笔画、扩展形状、框架）仍正常渲染；数据层与 `WbAiMenu.tsx`/`WhiteboardTemplatePicker.tsx`/`wb-templates` 等代码保留，仅无 UI 入口。

### 编辑器 Typora 化（第一批）

| 功能 | 关键文件 |
|------|----------|
| 统一保存模型（自动保存为唯一路径，状态栏三态 + 已保存时间） | `lib/save-state.ts`、`hooks/useNotes.ts`、`hooks/useKnowledgeBaseDocs.ts`、`components/StatusBar.tsx` |
| Note 查找替换（Ctrl+F，三种编辑模式）+ WYSIWYG 第 N 处定位 | `NoteDetail`、`lib/use-find-replace.ts`、`MilkdownEditor` |
| WYSIWYG 选区气泡菜单（加粗/斜体/删除线/高亮/行内代码/链接 popover；Ctrl+K） | `components/SelectionBubble.tsx`、`MilkdownEditor` |
| WYSIWYG 空文档 placeholder | `lib/milkdown-placeholder.ts`、`index.css` |
| 锁定时编辑档位禁用（无 effect 弹回） | `EditorModeSwitcher`（`disableEdit` prop）、`NoteDetail` |

## 12. 推荐阅读顺序

1. `README.md`
2. `docs/DESIGN.md`
3. `docs/IPC_API.md`
4. `src/shared/types.ts`
5. `src/main/store.ts` + `src/main/ipc-handlers.ts`
6. `src/renderer/src/App.tsx` + `src/renderer/src/hooks/*`
