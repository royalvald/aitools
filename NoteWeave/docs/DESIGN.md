# 织记（NoteWeave） 设计文档

## 1. 概述

织记（NoteWeave） 是一款面向 Windows 的本地优先桌面笔记/知识库应用，采用 Electron 作为桌面壳、React 作为 UI 框架，数据以本地 JSON / Markdown 文件形式持久化。

### 1.1 设计目标

- **本地优先**：数据保存在用户设备，无需账号和联网。
- **Markdown 原生**：标题和任务详情都支持 Markdown 编写与渲染。
- **轻量快速**：启动快，交互简洁；支持多窗口并行查看。
- **可扩展**：清晰的进程分层和类型化 IPC，便于后续增加同步、标签、搜索等功能。

### 1.2 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面运行时 | Electron | 35.x |
| 主进程语言 | Node.js + TypeScript | 22.x / 5.x |
| 渲染进程 UI | React | 19.x |
| 构建工具 | Vite + electron-vite | 6.x / 3.x |
| 样式 | Tailwind CSS | 4.x |
| Markdown 编辑 | @uiw/react-md-editor | 4.x |
| 富文本编辑 | Milkdown | 7.x |
| Markdown 渲染 | react-markdown + remark-gfm | 10.x / 4.x |
| 打包 | electron-builder | 26.x |

---

## 2. 架构设计

### 2.1 进程模型

Electron 应用包含三类进程：

```
┌─────────────────────────────────────────────────────────┐
│  主进程 (Main Process)                                   │
│  src/main/index.ts                                       │
│  ├─ 创建 BrowserWindow                                   │
│  ├─ 管理应用生命周期                                     │
│  ├─ 注册 IPC 处理器                                      │
│  └─ 通过 src/main/store.ts 读写本地 JSON                 │
└─────────────────────────────────────────────────────────┘
                            │ IPC (invoke/handle)
                            ▼
┌─────────────────────────────────────────────────────────┐
│  预加载进程 (Preload)                                    │
│  src/preload/index.ts                                    │
│  └─ contextBridge 暴露类型化 API：window.electronAPI     │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│  渲染进程 (Renderer Process)                             │
│  src/renderer/src/*                                      │
│  ├─ React 组件树                                         │
│  ├─ useNotes 数据管理 Hook                               │
│  └─ Markdown 编辑器/渲染组件                             │
└─────────────────────────────────────────────────────────┘
```

### 2.2 安全设计

- **Context Isolation 开启**：渲染进程无法直接访问 Node.js API。
- **Preload 桥接**：所有主进程能力通过 `contextBridge.exposeInMainWorld` 暴露。
- **类型化 IPC**：主进程与渲染进程共享 TypeScript 类型，编译期可发现接口不匹配。
- **CSP 策略**：渲染页面设置 Content-Security-Policy，限制外部脚本和样式。

### 2.3 数据流向

```
用户操作 (新建/编辑/删除)
    │
    ▼
React 组件 ──▶ useNotes Hook
    │
    ▼
window.electronAPI.* (preload 暴露)
    │
    ▼
ipcRenderer.invoke(channel, payload)
    │
    ▼
主进程 ipcMain.handle(channel, handler)
    │
    ▼
store.ts 读写本地 JSON
    │
    ▼
<安装目录>\data\notes\（开发模式：<项目根目录>\dev-data\notes\）
```

---

## 3. 数据模型

### 3.1 Note 实体

```typescript
interface Note {
  id: string        // UUID v4，唯一标识
  title: string     // Markdown 标题
  summary: string   // 内容纯文本摘要（自动生成）
  content: string   // Markdown 详情内容
  createdAt: string // ISO 8601 创建时间
  updatedAt: string // ISO 8601 更新时间
  linkedKbDocIds?: string[]  // 双向关联的知识库文档
  groupId?: string | null    // 所属分组，null/缺省=未分类
  tags?: string[]            // 标签
  locked?: boolean           // 只读锁定
  feedback?: string | null   // 文档反馈
}
```

> 知识库（KnowledgeBase）、知识库文档（KnowledgeBaseDoc，`docType: 'markdown' | 'mindmap'`）、批注、白板、待办等其余实体的定义见 `src/shared/types.ts`。

### 3.2 NoteSummary 列表视图

```typescript
interface NoteSummary {
  id: string
  title: string
  summary: string
  updatedAt: string
  groupId?: string | null
  tags?: string[]
  locked?: boolean
}
```

列表中只展示摘要，避免一次性读取大量完整内容。

### 3.3 文件存储格式

每个 note 一个 JSON 文件：`{id}.json`

示例：

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "## 周会",
  "summary": "讨论 Q3 排期和资源分配...",
  "content": "# 团队周会\n\n## 议程\n- [ ] 回顾上周进度\n- [ ] 制定本周计划",
  "createdAt": "2026-06-14T10:30:00.000Z",
  "updatedAt": "2026-06-14T14:20:00.000Z"
}
```

### 3.4 摘要生成算法

从 `content` 中提取前 120 个字符的纯文本：

1. 移除 Markdown 标题符号 `#`
2. 移除格式符号 `*_``~`
3. 链接转为纯文本
4. 图片标记移除
5. 换行替换为空格
6. 截取 120 字符，超出追加 `...`

---

## 4. IPC 接口设计

业务调用均为 `invoke/handle` 模式，异步返回 Promise；通道命名遵循 `domain:action`。完整通道清单见 `docs/IPC_API.md` 与 `src/main/ipc-handlers.ts`（约 100 个 invoke 通道），覆盖 `notes:*`、`noteGroup:*`、`kb:*`、`kbDoc:*`、`annotation:*`、`link:*`、`todo:*`、`whiteboard:*`、`mindmap:*`、`settings:*`、`search:*`、`history:*`、`trash:*`、`template:*`、`theme:*`、`asset:*` 等域。小记核心通道：

| 通道 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `notes:list` | 无 | `NoteSummary[]` | 获取全部 note，按更新时间倒序 |
| `notes:get` | `id: string` | `Note \| null` | 获取完整 note |
| `notes:create` | `groupId?: string \| null` | `Note` | 创建空白 note 并返回 |
| `notes:save` | `note: Note` | `Note` | 保存 note，自动更新摘要和时间 |
| `notes:delete` | `id: string` | `boolean` | 删除 note 文件 |

### 4.1 Preload 暴露的 API

`src/preload/index.ts` 通过 `contextBridge` 暴露类型化的 `window.electronAPI`，每个方法一一对应一个 IPC 通道；完整接口定义见 `src/shared/types.ts` 的 `ElectronAPI`。

---

## 5. UI 组件设计

### 5.1 布局结构

语雀式信息架构：左侧图标导航栏（`AppNavRail`）+ 主内容区；小记详情以覆盖层呈现。

```
┌──────────────────────────────────────────────────────────┐
│ 织记（NoteWeave）                              [—] [□] [×]  │
├────┬─────────────────────────────────────────────────────┤
│ 导 │  主内容区（按一级视图切换）                            │
│ 航 │  ├─ 工作台 Dashboard：问候 + 快捷新建 + 最近/收藏/    │
│ 栏 │  │   小记/待办 Tab                                   │
│ 工 │  ├─ 知识库网格 KbGridPage：知识库卡片                 │
│ 作 │  ├─ 知识库内部 KbDetail：左侧文档树 + 右侧文档区      │
│ 台 │  └─ 小记详情覆盖层 NoteDetail：面包屑 + 阅读优先      │
│ 知 │                                                     │
│ 识 │                                                     │
│ 库 │                                                     │
├────┴─────────────────────────────────────────────────────┤
│ 状态栏：保存状态 / 字数统计等                               │
└──────────────────────────────────────────────────────────┘
```

### 5.2 组件职责

| 组件 | 职责 |
|------|------|
| `App` | 根组件，按状态渲染一级视图与小记详情覆盖层；区分主窗口 / `?quicknote=1` 浮窗 |
| `AppNavRail` | 左侧图标导航栏：工作台/知识库 + 搜索/数据/资源/回收站/主题/设置 |
| `Dashboard` | 工作台：问候、快捷新建、最近/收藏/小记/待办 Tab |
| `KbGridPage` / `KbDetail` | 知识库卡片网格 / KB 内部（目录树 `KbDocTree` + 文档区） |
| `NoteListItem` / `NoteDetail` | 列表项 / 小记详情（面包屑 + 阅读优先，「编辑/完成」切换） |
| `KbDocEditor` | 知识库文档编辑器（阅读优先 + 右侧大纲/讨论面板，可切换到白板视图） |
| `NoteEditor` | 封装 `@uiw/react-md-editor`（Markdown 源码） |
| `MilkdownEditor` | 富文本 WYSIWYG 编辑器（含选区气泡、斜杠菜单） |
| `NotePreview` | 封装 `react-markdown + remark-gfm`，只读渲染 |
| `Whiteboard` / `WhiteboardCanvas` | 白板（仅浏览模式：平移/缩放/内容卡片跳转） |
| `GlobalSearch` | 三合一浮层：全文搜索 / 快速打开 / 命令面板 |
| `useNotes` | 管理 note 列表、选中状态、创建/保存/删除、自动保存防抖 |

### 5.3 Markdown 处理策略

#### 标题

- 列表渲染：只允许内联元素 `strong`, `em`, `code`, `a`, `del`
- 为空时显示“无标题”

#### 详情

- 编辑：富文本（Milkdown 所见即所得）/ Markdown 源码两档切换，阅读优先
- 预览：使用 `react-markdown + remark-gfm`（统一配置在 `lib/markdown-plugins.tsx`），支持表格、任务列表、代码块、公式、Mermaid 图表等

---

## 6. 状态管理

### 6.1 useNotes Hook

```typescript
const {
  notes,          // NoteSummary[] 列表数据
  selectedId,     // 当前选中的 note id
  selectedNote,   // 当前选中的完整 Note
  isLoading,      // 加载状态
  createNote,     // 创建
  saveNote,       // 立即保存
  changeNote,     // 修改字段（带自动保存防抖）
  deleteNote,     // 删除
  refresh         // 刷新列表
} = useNotes()
```

### 6.2 自动保存机制

- 用户在编辑器中输入时，`changeNote` 先更新本地状态（即时响应）。
- 使用 `setTimeout` 500ms 防抖。
- 防抖结束后调用 `notes:save` IPC，保存到本地文件。
- 保存成功后刷新列表摘要和时间。
- 自动保存是唯一保存路径（Typora 式，无手动保存按钮）；保存状态（unsaved/saving/saved + 完成时间）由 `lib/save-state.ts` 统一上报，状态栏直接订阅；菜单「保存」（Ctrl+S）可立即触发落盘。

---

## 7. 构建与打包

### 7.1 构建流程

```bash
npm run build
```

electron-vite 会分别构建：

1. **main**：`src/main/index.ts` → `out/main/index.js`
2. **preload**：`src/preload/index.ts` → `out/preload/index.js`
3. **renderer**：`src/renderer/index.html` → `out/renderer/`

### 7.2 打包流程

```bash
npm run package:win
```

electron-builder 读取 `electron-builder.yml`：

- 下载 Electron 运行时
- 将 `out/` 目录打包到 `dist/win-unpacked/`
- 生成 NSIS 安装程序 `NoteWeave Setup 1.0.0.exe`
- 生成便携版 `NoteWeave-1.0.0-portable.exe`

---

## 8. 扩展性考虑

### 8.1 已落地的扩展方向

标签/分类、全文搜索、多窗口、导入/导出、富文本附件等均已在后续版本实现（见 `AGENTS.md` 功能地图）。

### 8.2 未来可扩展功能

- **云同步**：替换 store.ts 为支持云存储的抽象层，或增加同步守护进程。
- **协作**：在同步层之上扩展多人协作与冲突合并。

### 8.3 当前限制

- 白板为仅浏览模式：可平移/缩放查看已有内容，不能新建或编辑画布元素。
- 标题只支持内联 Markdown，不支持块级元素。

---

## 9. 目录结构

```
notefordetail/
├── docs/                          # 文档
│   ├── DESIGN.md                  # 本文件
│   ├── IPC_API.md                 # IPC 接口文档
│   └── USER_GUIDE.md              # 用户使用手册
├── buildResources/                # 打包资源（图标等）
├── out/                           # 构建输出
├── dist/                          # 打包输出
├── test/                          # Vitest 测试（纯函数模块）
├── src/
│   ├── shared/
│   │   ├── types.ts               # 共享类型定义与 ElectronAPI 接口
│   │   └── *-helpers.ts           # 主/渲染进程共用的纯函数模块
│   ├── main/
│   │   ├── index.ts               # 主进程入口
│   │   ├── store.ts               # JSON 存储
│   │   ├── ipc-handlers.ts        # IPC 处理器
│   │   └── *.ts                   # 导出/导入/OCR/AI/白板等业务模块
│   ├── preload/
│   │   └── index.ts               # 预加载桥接
│   └── renderer/src/
│       ├── main.tsx               # React 入口
│       ├── App.tsx                # 根组件
│       ├── index.css              # 全局样式（Tailwind v4 主题）
│       ├── types.ts               # 渲染进程类型入口
│       ├── components/            # UI 组件
│       ├── hooks/                 # 自定义 Hooks
│       └── lib/                   # 工具函数
├── electron-builder.yml           # 打包配置
├── electron.vite.config.ts        # Vite 构建配置
├── tsconfig.json                  # TypeScript 配置
├── package.json                   # 项目依赖与脚本
└── README.md                      # 项目简介
```
