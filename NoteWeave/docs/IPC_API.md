# 织记（NoteWeave） IPC API 文档

本文档描述 织记（NoteWeave） 主进程与渲染进程之间的 IPC 接口。

## 接口概述

所有 IPC 调用均为异步 `invoke/handle` 模式，渲染进程通过 `window.electronAPI` 调用。

## 类型定义

```typescript
// src/shared/types.ts（节选）

export interface Note {
  id: string
  title: string
  summary: string
  content: string
  createdAt: string
  updatedAt: string
  linkedKbDocIds?: string[]
  groupId?: string | null
  tags?: string[]
  locked?: boolean
  feedback?: string | null
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
```

> `ElectronAPI` 完整接口约百个方法，定义见 `src/shared/types.ts`，实际注册通道以 `src/main/ipc-handlers.ts` 为准；除下述 `invoke/handle` 通道外，还有少量 `send/on` 单向通道（见文末 v1.2 通道表）。

## 通道说明

### `notes:list`

获取所有 note 的摘要列表，按 `updatedAt` 降序排列。

**调用：**

```typescript
const notes = await window.electronAPI.listNotes()
```

**返回：**

```typescript
NoteSummary[]
```

---

### `notes:get`

根据 ID 获取完整的 note 内容。

**调用：**

```typescript
const note = await window.electronAPI.getNote('550e8400-...')
```

**参数：**

- `id`: string — note 的唯一标识

**返回：**

```typescript
Note | null
```

如果 note 不存在，返回 `null`。

---

### `notes:create`

创建一个新的空白 note 并返回。

**调用：**

```typescript
const note = await window.electronAPI.createNote()
// 或指定分组：window.electronAPI.createNote(groupId)
```

**参数：**

- `groupId?`: string | null — 可选，所属分组；缺省/null 为未分类

**返回：**

```typescript
Note
```

新建的 note 字段：

```typescript
{
  id: 'uuid',
  title: '',
  summary: '',
  content: '',
  createdAt: 'ISO 时间',
  updatedAt: 'ISO 时间'
}
```

---

### `notes:save`

保存 note，主进程会自动更新 `summary` 和 `updatedAt`。

**调用：**

```typescript
const updated = await window.electronAPI.saveNote(note)
```

**参数：**

- `note`: Note — 要保存的 note 对象

**返回：**

```typescript
Note
```

保存后的 `title` 如果为空字符串，会被替换为“无标题”。

---

### `notes:delete`

根据 ID 删除 note。

**调用：**

```typescript
const ok = await window.electronAPI.deleteNote('550e8400-...')
```

**参数：**

- `id`: string — 要删除的 note ID

**返回：**

```typescript
boolean
```

删除成功返回 `true`，失败（如文件不存在）返回 `false`。

## 使用示例

```typescript
import { useEffect, useState } from 'react'
import type { Note, NoteSummary } from './types'

function Example() {
  const [notes, setNotes] = useState<NoteSummary[]>([])

  useEffect(() => {
    window.electronAPI.listNotes().then(setNotes)
  }, [])

  const handleCreate = async () => {
    const note = await window.electronAPI.createNote()
    setNotes(await window.electronAPI.listNotes())
  }

  return (
    <div>
      <button onClick={handleCreate}>新建</button>
      <ul>
        {notes.map((n) => (
          <li key={n.id}>{n.title}</li>
        ))}
      </ul>
    </div>
  )
}
```

## 批注（Annotation）通道

KB Doc 内容级批注，存储于 `{userData}/knowledge-bases/{kbId}/{docId}.annotations.json`。

```typescript
export interface KbDocAnnotation {
  id: string
  kbId: string
  docId: string
  text: string        // 选中的原文片段
  startOffset: number // 在 doc.content 中的起始字符偏移
  endOffset: number   // 在 doc.content 中的结束字符偏移
  content: string     // 用户填写的批注文字
  createdAt: string
  updatedAt: string
}
```

### `annotation:list`

获取指定文档的全部批注，按 `startOffset` 升序排列。

```typescript
const annotations = await window.electronAPI.listAnnotations(kbId, docId)
```

### `annotation:create`

```typescript
const annotation = await window.electronAPI.createAnnotation(
  kbId, docId, text, startOffset, endOffset, content
)
```

### `annotation:update`

仅可修改批注内容（`content`），关联的高亮范围（`text`/`startOffset`/`endOffset`）保持原值。写入前校验 `id` 存在，否则抛错。

```typescript
const updated = await window.electronAPI.updateAnnotation(annotation)
```

### `annotation:delete`

```typescript
const ok = await window.electronAPI.deleteAnnotation(kbId, docId, id)
```

### `annotation:addReply` / `annotation:deleteReply`

批注回复（REQ-015）：为指定批注追加一条回复，或按回复 id 删除回复。

> **批注数量**：`listKbDocs` 返回的 `KnowledgeBaseDocSummary.annotationCount` 由主进程运行时动态读取 `.annotations.json` 计数注入，**不持久化**进 `meta.json`。删除文档（`kbDoc:delete`）时会一并清理对应批注文件。

---

## v1.2 新增 IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `recent:record` | invoke | 记录最近打开项，截断 20 |
| `recent:pin` / `recent:unpin` | invoke | 固定/取消固定 |
| `command:recordUse` | invoke | 记录命令面板最近使用 |
| `theme:list` / `theme:get` / `theme:save` / `theme:delete` | invoke | 自定义主题 CRUD |
| `theme:resolveCss` | invoke | 解析主题名→CSS（REQ-111） |
| `diagram:checkJava` / `diagram:checkGraphviz` | invoke | 检测本地渲染后端可用性 |
| `diagram:plantuml` / `diagram:graphviz` | invoke | 本地渲染 SVG（REQ-115） |
| `lint:check` | invoke | Markdown Lint 检查（REQ-118） |
| `pandoc:detect` | invoke | 检测系统 Pandoc（REQ-119） |
| `externalKb:mount` | invoke | 挂载本地文件夹为外部知识库（REQ-120） |
| `externalKb:refresh` | invoke | 重新扫描外部知识库 |
| `externalKb:subscribe` / `externalKb:unsubscribe` | send | 订阅/取消订阅外部文件夹监听 |
| `externalKb:changed` | send (主→渲染) | 外部知识库发生变化的通知 |
| `window:open-target` | send | 在新应用窗口打开指定目标（REQ-117） |
| `window:new` | send | 新建空窗口 |
| `menu:quick-open` / `menu:command-palette` | send (主→渲染) | 菜单触发 |
| `menu:toggle-focus` / `menu:toggle-typewriter` / `menu:present` | send (主→渲染) | 视图菜单触发 |
| `menu:open-external-folder` | send | 触发文件夹选择挂载 |
| `history:save` | invoke | 显式写入历史快照（修复 v1.1 遗漏的注册） |

`export:doc` 的 `format` 联合扩展为 `'pdf' | 'html' | 'word' | 'epub' | 'latex' | 'rtf' | 'txt' | 'opml' | 'markdown'`，`options` 增加 `themeName` / `usePandoc`。
