import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import type {
  AnnotationReply,
  AppLockConfig,
  AppSettings,
  AssetItem,
  Backlink,
  CommentReply,
  DocMention,
  FavoriteItem,
  HistoryItem,
  HistorySummary,
  KnowledgeBase,
  KnowledgeBaseDoc,
  KnowledgeBaseDocSummary,
  KnowledgeBaseSummary,
  KbDocAnnotation,
  KbDocComment,
  LintIssue,
  Note,
  NoteGroup,
  NoteSummary,
  PinnedItem,
  RecentItem,
  SearchHitType,
  SearchHistoryItem,
  SearchResult,
  TemplateDoc,
  ThemeDoc,
  ThemeSummary,
  Todo,
  TodoTargetType,
  TrashItem,
  TrashSummary,
  Whiteboard
} from '../shared/types'
import { stripFrontMatter } from '../shared/front-matter'

// 数据目录基于 app.getPath('userData')，必须在 index.ts 中通过 app.setPath('userData', ...)
// 重定向之后再实际读取，因此这里采用惰性求值（getter），避免在模块加载阶段固化路径。
export function getNotesDir(): string {
  return path.join(app.getPath('userData'), 'notes')
}

export function getKnowledgeBasesDir(): string {
  return path.join(app.getPath('userData'), 'knowledge-bases')
}

export function getTodosDir(): string {
  return path.join(app.getPath('userData'), 'todos')
}

function getKbMetaFile(): string {
  return path.join(getKnowledgeBasesDir(), 'kb-meta.json')
}

async function ensureNotesDir(): Promise<void> {
  await fs.mkdir(getNotesDir(), { recursive: true })
}

async function ensureKnowledgeBasesDir(): Promise<void> {
  await fs.mkdir(getKnowledgeBasesDir(), { recursive: true })
}

function getNotePath(id: string): string {
  return path.join(getNotesDir(), `${id}.json`)
}

function getKbDir(kbId: string): string {
  return path.join(getKnowledgeBasesDir(), kbId)
}

function getKbDocsMetaPath(kbId: string): string {
  return path.join(getKbDir(kbId), 'meta.json')
}

function getKbDocContentPath(kbId: string, docId: string): string {
  return path.join(getKbDir(kbId), `${docId}.md`)
}

function generateSummary(content: string): string {
  // REQ-103：摘要不应包含 front matter 块。
  const body = stripFrontMatter(content)
  const plain = body
    .replace(/#{1,6}\s+/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  return plain.slice(0, 120) + (plain.length > 120 ? '...' : '')
}

function stripMarkdownTitle(title: string): string {
  return title.replace(/^#{1,6}\s+/gm, '').trim()
}

// #region Notes

export async function listNotes(): Promise<NoteSummary[]> {
  await ensureNotesDir()
  const notesDir = getNotesDir()
  const files = await fs.readdir(notesDir)
  const notes: NoteSummary[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(notesDir, file), 'utf-8')
      const note = JSON.parse(raw) as Note
      notes.push({
        id: note.id,
        title: note.title || '无标题',
        summary: note.summary || generateSummary(note.content),
        updatedAt: note.updatedAt,
        groupId: note.groupId ?? null,
        tags: note.tags ?? [],
        locked: note.locked ?? false
      })
    } catch {
      // Ignore corrupted files
    }
  }

  return notes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export async function getNote(id: string): Promise<Note | null> {
  try {
    const raw = await fs.readFile(getNotePath(id), 'utf-8')
    return JSON.parse(raw) as Note
  } catch {
    return null
  }
}

export async function createNote(groupId?: string | null): Promise<Note> {
  await ensureNotesDir()
  const now = new Date().toISOString()
  const note: Note = {
    id: uuidv4(),
    title: '',
    summary: '',
    content: '',
    createdAt: now,
    updatedAt: now,
    groupId: groupId ?? null
  }
  await fs.writeFile(getNotePath(note.id), JSON.stringify(note, null, 2), 'utf-8')
  return note
}

export async function saveNote(note: Note): Promise<Note> {
  await ensureNotesDir()
  const existing = await getNote(note.id)
  const now = new Date().toISOString()
  const updated: Note = {
    ...note,
    title: note.title.trim() === '' ? '无标题' : note.title,
    summary: generateSummary(note.content),
    linkedKbDocIds: note.linkedKbDocIds ?? existing?.linkedKbDocIds ?? [],
    groupId: note.groupId ?? existing?.groupId ?? null,
    tags: note.tags ?? existing?.tags ?? [],
    locked: note.locked ?? existing?.locked ?? false,
    feedback: note.feedback ?? existing?.feedback ?? null,
    createdAt: existing?.createdAt ?? note.createdAt,
    updatedAt: now
  }
  await fs.writeFile(getNotePath(note.id), JSON.stringify(updated, null, 2), 'utf-8')
  // REQ-014：内容变化时写一个历史快照（失败不影响保存）。
  saveHistorySnapshot('note', updated.id, updated.content).catch(() => {})
  return updated
}

export async function deleteNote(id: string): Promise<boolean> {
  try {
    // REQ-013：先转入回收站再删除文件，支持恢复。
    const existing = await getNote(id)
    if (existing) {
      await moveToTrash({
        kind: 'note',
        originalId: id,
        name: existing.title || '无标题',
        payload: existing
      })
    }
    await fs.unlink(getNotePath(id))

    // Clean up links from KB docs
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      const docs = await readKbDocsMeta(kb.id)
      let changed = false
      const updated = docs.map((doc) => {
        if (doc.linkedNoteIds?.includes(id)) {
          changed = true
          return { ...doc, linkedNoteIds: doc.linkedNoteIds.filter((noteId) => noteId !== id) }
        }
        return doc
      })
      if (changed) {
        await writeKbDocsMeta(kb.id, updated)
      }
    }

    // Clean up todos pointing to this note
    await deleteTodosByTarget('note', id)

    // REQ-223 标记引用了该 Note 的白板内容卡片为失效
    await invalidateContentCards('note', id)

    return true
  } catch {
    return false
  }
}

// #endregion

// #region Note groups (two-level classification)

function getNoteGroupsFile(): string {
  return path.join(getNotesDir(), 'groups.json')
}

async function readNoteGroups(): Promise<NoteGroup[]> {
  try {
    const raw = await fs.readFile(getNoteGroupsFile(), 'utf-8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? (data as NoteGroup[]) : []
  } catch {
    return []
  }
}

async function writeNoteGroups(groups: NoteGroup[]): Promise<void> {
  await ensureNotesDir()
  await fs.writeFile(getNoteGroupsFile(), JSON.stringify(groups, null, 2), 'utf-8')
}

export async function listNoteGroups(): Promise<NoteGroup[]> {
  const groups = await readNoteGroups()
  return groups.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
}

export async function createNoteGroup(name: string, parentId: string | null): Promise<NoteGroup> {
  const groups = await readNoteGroups()
  const trimmed = name.trim() || '新建分组'
  // 深度校验：parentId 非空时，其父分组必须存在且本身是一级分组（parentId===null），
  // 否则会形成超过两级的嵌套。
  if (parentId) {
    const parent = groups.find((g) => g.id === parentId)
    if (!parent) {
      throw new Error('父分组不存在')
    }
    if (parent.parentId !== null) {
      throw new Error('仅支持两级分组')
    }
  }
  const now = new Date().toISOString()
  const group: NoteGroup = {
    id: uuidv4(),
    name: trimmed,
    parentId: parentId ?? null,
    createdAt: now,
    updatedAt: now
  }
  groups.push(group)
  await writeNoteGroups(groups)
  return group
}

export async function updateNoteGroup(id: string, name: string): Promise<NoteGroup> {
  const groups = await readNoteGroups()
  const group = groups.find((g) => g.id === id)
  if (!group) {
    throw new Error('分组不存在')
  }
  group.name = name.trim() || group.name
  group.updatedAt = new Date().toISOString()
  await writeNoteGroups(groups)
  return group
}

// 删除分组：若是一级分组则级联删除其全部二级子分组；
// 所有被删分组内的 Note 不删除，仅把 groupId 置空（变为未分类）。
export async function deleteNoteGroup(id: string): Promise<boolean> {
  try {
    const groups = await readNoteGroups()
    const removedIds = new Set<string>([id])
    // 收集被删一级分组下的全部二级分组
    for (const g of groups) {
      if (g.parentId === id) {
        removedIds.add(g.id)
      }
    }
    const remaining = groups.filter((g) => !removedIds.has(g.id))
    await writeNoteGroups(remaining)

    // 把归属被删分组的 Note 改为未分类
    const files = await fs.readdir(getNotesDir())
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'groups.json') continue
      try {
        const fullPath = path.join(getNotesDir(), file)
        const raw = await fs.readFile(fullPath, 'utf-8')
        const note = JSON.parse(raw) as Note
        if (note.groupId && removedIds.has(note.groupId)) {
          note.groupId = null
          note.updatedAt = new Date().toISOString()
          await fs.writeFile(fullPath, JSON.stringify(note, null, 2), 'utf-8')
        }
      } catch {
        // Ignore corrupted single note files
      }
    }
    return true
  } catch {
    return false
  }
}

// #endregion

async function readKbMeta(): Promise<KnowledgeBase[]> {
  await ensureKnowledgeBasesDir()
  try {
    const raw = await fs.readFile(getKbMetaFile(), 'utf-8')
    return JSON.parse(raw) as KnowledgeBase[]
  } catch {
    return []
  }
}

async function writeKbMeta(kbs: KnowledgeBase[]): Promise<void> {
  await ensureKnowledgeBasesDir()
  await fs.writeFile(getKbMetaFile(), JSON.stringify(kbs, null, 2), 'utf-8')
}

export async function listKnowledgeBases(): Promise<KnowledgeBaseSummary[]> {
  const kbs = await readKbMeta()
  return kbs
    .map((kb) => ({
      id: kb.id,
      name: kb.name || '未命名知识库',
      category: kb.category || '未分类',
      updatedAt: kb.updatedAt,
      source: kb.source
    }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export async function getKnowledgeBase(id: string): Promise<KnowledgeBase | null> {
  const kbs = await readKbMeta()
  return kbs.find((kb) => kb.id === id) ?? null
}

export async function createKnowledgeBase(name: string, category: string): Promise<KnowledgeBase> {
  await ensureKnowledgeBasesDir()
  const now = new Date().toISOString()
  const kb: KnowledgeBase = {
    id: uuidv4(),
    name: name.trim() || '未命名知识库',
    category: category.trim() || '未分类',
    createdAt: now,
    updatedAt: now
  }
  const kbs = await readKbMeta()
  kbs.push(kb)
  await writeKbMeta(kbs)
  await fs.mkdir(getKbDir(kb.id), { recursive: true })
  await fs.writeFile(getKbDocsMetaPath(kb.id), JSON.stringify([], null, 2), 'utf-8')
  return kb
}

export async function updateKnowledgeBase(kb: KnowledgeBase): Promise<KnowledgeBase> {
  const kbs = await readKbMeta()
  const index = kbs.findIndex((item) => item.id === kb.id)
  if (index === -1) throw new Error(`Knowledge base not found: ${kb.id}`)
  const now = new Date().toISOString()
  const updated: KnowledgeBase = {
    ...kbs[index],
    name: kb.name.trim() || '未命名知识库',
    category: kb.category.trim() || '未分类',
    updatedAt: now
  }
  kbs[index] = updated
  await writeKbMeta(kbs)
  return updated
}

export async function deleteKnowledgeBase(id: string): Promise<boolean> {
  try {
    const kbs = await readKbMeta()
    const target = kbs.find((kb) => kb.id === id)
    if (!target) return false

    // REQ-013：先把该知识库下的每篇文档（含内容）转入回收站，再删除知识库元数据。
    // 这样恢复知识库后，可逐条从回收站恢复其文档（restoreTrash 对 kbDoc 会重建内容与 meta）。
    const docs = await readKbDocsMeta(id)
    for (const doc of docs) {
      let content = ''
      try {
        content = await fs.readFile(getKbDocContentPath(id, doc.id), 'utf-8')
      } catch {
        // ignore
      }
      await moveToTrash({
        kind: 'kbDoc',
        originalId: doc.id,
        kbId: id,
        parentId: doc.parentId ?? null,
        name: doc.name || '未命名文档',
        payload: {
          id: doc.id,
          kbId: id,
          name: doc.name || '未命名文档',
          content,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          linkedNoteIds: doc.linkedNoteIds ?? [],
          parentId: doc.parentId ?? null,
          order: doc.order ?? 0,
          tags: doc.tags ?? [],
          locked: doc.locked ?? false,
          feedback: doc.feedback ?? null,
          docType: doc.docType ?? 'markdown'
        } as KnowledgeBaseDoc
      })
    }

    // 知识库元数据本身也进回收站（payload 含 doc 列表快照，便于恢复时重建 meta.json）。
    await moveToTrash({
      kind: 'knowledgeBase',
      originalId: id,
      name: target.name || '未命名知识库',
      payload: { ...target, _docsSnapshot: docs }
    })
    const filtered = kbs.filter((kb) => kb.id !== id)
    await writeKbMeta(filtered)
    await fs.rm(getKbDir(id), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// #endregion

// #region Knowledge base documents

async function readKbDocsMeta(kbId: string): Promise<KnowledgeBaseDocSummary[]> {
  try {
    const raw = await fs.readFile(getKbDocsMetaPath(kbId), 'utf-8')
    return JSON.parse(raw) as KnowledgeBaseDocSummary[]
  } catch {
    return []
  }
}

async function writeKbDocsMeta(kbId: string, docs: KnowledgeBaseDocSummary[]): Promise<void> {
  await fs.writeFile(getKbDocsMetaPath(kbId), JSON.stringify(docs, null, 2), 'utf-8')
}

export async function listKbDocs(kbId: string): Promise<KnowledgeBaseDocSummary[]> {
  const docs = await readKbDocsMeta(kbId)
  const result: KnowledgeBaseDocSummary[] = []
  for (const doc of docs) {
    result.push({
      ...doc,
      name: doc.name || '未命名文档',
      annotationCount: await countAnnotations(kbId, doc.id)
    })
  }
  // REQ-006：按 order 升序（缺省视为 0），同级稳定；无 order 时退化为 updatedAt 倒序以兼容旧数据。
  const anyOrdered = result.some((d) => typeof d.order === 'number')
  if (anyOrdered) {
    return result.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }
  return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export async function getKbDoc(kbId: string, docId: string): Promise<KnowledgeBaseDoc | null> {
  try {
    const docs = await readKbDocsMeta(kbId)
    const meta = docs.find((doc) => doc.id === docId)
    if (!meta) return null
    const content = await fs.readFile(getKbDocContentPath(kbId, docId), 'utf-8')
    return {
      id: meta.id,
      kbId,
      name: meta.name || '未命名文档',
      content,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      linkedNoteIds: meta.linkedNoteIds ?? [],
      parentId: meta.parentId ?? null,
      order: meta.order ?? 0,
      tags: meta.tags ?? [],
      locked: meta.locked ?? false,
      feedback: meta.feedback ?? null,
      docType: meta.docType ?? 'markdown'
    }
  } catch {
    return null
  }
}

export async function createKbDoc(kbId: string, name: string): Promise<KnowledgeBaseDoc> {
  await fs.mkdir(getKbDir(kbId), { recursive: true })
  const now = new Date().toISOString()
  const docId = uuidv4()
  const docSummary: KnowledgeBaseDocSummary = {
    id: docId,
    kbId,
    name: name.trim() || '未命名文档',
    createdAt: now,
    updatedAt: now,
    linkedNoteIds: []
  }
  const docs = await readKbDocsMeta(kbId)
  docs.push(docSummary)
  await writeKbDocsMeta(kbId, docs)
  await fs.writeFile(getKbDocContentPath(kbId, docId), '', 'utf-8')

  // Update KB updatedAt
  const kbs = await readKbMeta()
  const kbIndex = kbs.findIndex((kb) => kb.id === kbId)
  if (kbIndex !== -1) {
    kbs[kbIndex].updatedAt = now
    await writeKbMeta(kbs)
  }

  return {
    ...docSummary,
    content: '',
    createdAt: now
  }
}

export async function saveKbDoc(doc: KnowledgeBaseDoc): Promise<KnowledgeBaseDoc> {
  const now = new Date().toISOString()
  const docs = await readKbDocsMeta(doc.kbId)
  const index = docs.findIndex((item) => item.id === doc.id)
  if (index === -1) throw new Error(`KB doc not found: ${doc.id}`)

  const updatedSummary: KnowledgeBaseDocSummary = {
    ...docs[index],
    name: doc.name.trim() || '未命名文档',
    updatedAt: now,
    linkedNoteIds: doc.linkedNoteIds ?? docs[index].linkedNoteIds ?? [],
    parentId: doc.parentId ?? docs[index].parentId ?? null,
    order: typeof doc.order === 'number' ? doc.order : docs[index].order ?? 0,
    tags: doc.tags ?? docs[index].tags ?? [],
    locked: doc.locked ?? docs[index].locked ?? false,
    feedback: doc.feedback ?? docs[index].feedback ?? null,
    docType: doc.docType ?? docs[index].docType ?? 'markdown'
  }
  docs[index] = updatedSummary
  await writeKbDocsMeta(doc.kbId, docs)
  await fs.writeFile(getKbDocContentPath(doc.kbId, doc.id), doc.content, 'utf-8')

  // Update KB updatedAt
  const kbs = await readKbMeta()
  const kbIndex = kbs.findIndex((kb) => kb.id === doc.kbId)
  if (kbIndex !== -1) {
    kbs[kbIndex].updatedAt = now
    await writeKbMeta(kbs)
  }

  // REQ-014：内容变化时写一个历史快照（失败不影响保存）。
  saveHistorySnapshot('kbDoc', doc.id, doc.content).catch(() => {})

  return {
    ...updatedSummary,
    content: doc.content,
    createdAt: docs[index].createdAt ?? now
  }
}

export async function deleteKbDoc(kbId: string, docId: string): Promise<boolean> {
  try {
    const docs = await readKbDocsMeta(kbId)
    const target = docs.find((doc) => doc.id === docId)
    if (!target) return false
    // REQ-013：保留完整内容快照供恢复。
    let content = ''
    try {
      content = await fs.readFile(getKbDocContentPath(kbId, docId), 'utf-8')
    } catch {
      // ignore
    }
    await moveToTrash({
      kind: 'kbDoc',
      originalId: docId,
      kbId,
      parentId: target.parentId ?? null,
      name: target.name || '未命名文档',
      payload: {
        id: docId,
        kbId,
        name: target.name || '未命名文档',
        content,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        linkedNoteIds: target.linkedNoteIds ?? [],
        parentId: target.parentId ?? null,
        order: target.order ?? 0,
        tags: target.tags ?? [],
        locked: target.locked ?? false,
        feedback: target.feedback ?? null,
        docType: target.docType ?? 'markdown'
      } as KnowledgeBaseDoc
    })
    const filtered = docs.filter((doc) => doc.id !== docId)
    await writeKbDocsMeta(kbId, filtered)
    await fs.unlink(getKbDocContentPath(kbId, docId))

    // Clean up links from notes
    const notes = await listNotes()
    for (const summary of notes) {
      const note = await getNote(summary.id)
      if (note?.linkedKbDocIds?.includes(docId)) {
        note.linkedKbDocIds = note.linkedKbDocIds.filter((id) => id !== docId)
        await saveNote(note)
      }
    }

    // Clean up whiteboard
    await deleteWhiteboard(kbId, docId)

    // REQ-211 Clean up table data file
    await deleteSidecarFile(kbId, docId, '.table.json')
    // REQ-213 Clean up database file (future)
    await deleteSidecarFile(kbId, docId, '.database.json')
    // REQ-212 Clean up mindmap file (future)
    await deleteSidecarFile(kbId, docId, '.mindmap.json')
    // REQ-214 Clean up slides file (future)
    await deleteSidecarFile(kbId, docId, '.slides.json')

    // Clean up annotations
    await deleteAnnotationsFile(kbId, docId)

    // REQ-203 Clean up comments
    await deleteCommentsFile(kbId, docId)

    // Clean up todos pointing to this doc
    await deleteTodosByTarget('kbDoc', docId)

    // REQ-223 标记引用了该 KB Doc 的白板内容卡片为失效
    await invalidateContentCards('kbDoc', docId)

    return true
  } catch {
    return false
  }
}

// #endregion

// #region Whiteboards

const WHITEBOARD_SUFFIX = '.whiteboard.json'

function getWhiteboardPath(kbId: string, docId: string): string {
  return path.join(getKbDir(kbId), `${docId}${WHITEBOARD_SUFFIX}`)
}

export async function getWhiteboard(kbId: string, docId: string): Promise<Whiteboard | null> {
  try {
    const raw = await fs.readFile(getWhiteboardPath(kbId, docId), 'utf-8')
    return JSON.parse(raw) as Whiteboard
  } catch {
    return null
  }
}

export async function saveWhiteboard(whiteboard: Whiteboard): Promise<Whiteboard> {
  const now = new Date().toISOString()
  const toSave: Whiteboard = {
    ...whiteboard,
    updatedAt: now
  }
  await fs.writeFile(
    getWhiteboardPath(whiteboard.kbId, whiteboard.docId),
    JSON.stringify(toSave, null, 2),
    'utf-8'
  )
  // REQ-229 白板保存时同步更新关联文档的 updatedAt（保持文档列表排序新鲜）
  try {
    const docs = await readKbDocsMeta(whiteboard.kbId)
    const idx = docs.findIndex((d) => d.id === whiteboard.docId)
    if (idx !== -1) {
      docs[idx] = { ...docs[idx], updatedAt: now }
      await writeKbDocsMeta(whiteboard.kbId, docs)
    }
  } catch {
    // ignore
  }
  return toSave
}

export async function deleteWhiteboard(kbId: string, docId: string): Promise<boolean> {
  try {
    await fs.unlink(getWhiteboardPath(kbId, docId))
    return true
  } catch {
    return false
  }
}

// REQ-223 把引用了被删 Note/KB Doc 的内容卡片标记为 invalid。
// 遍历所有知识库的所有白板，更新匹配卡片的 invalid 字段并落盘。
export async function invalidateContentCards(
  kind: 'note' | 'kbDoc',
  targetId: string
): Promise<void> {
  try {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        let wb: Whiteboard | null = null
        try {
          const raw = await fs.readFile(getWhiteboardPath(kb.id, doc.id), 'utf-8')
          wb = JSON.parse(raw) as Whiteboard
        } catch {
          continue
        }
        if (!wb || !Array.isArray(wb.elements) || wb.elements.length === 0) continue
        let changed = false
        const elements = wb.elements.map((el) => {
          if (
            el &&
            typeof el === 'object' &&
            (el as { type?: string }).type === 'content' &&
            (el as { targetKind?: string }).targetKind === kind &&
            (el as { targetId?: string }).targetId === targetId
          ) {
            changed = true
            return { ...el, invalid: true, updatedAt: new Date().toISOString() }
          }
          return el
        })
        if (changed) {
          await saveWhiteboard({ ...wb, elements })
        }
      }
    }
  } catch {
    // ignore
  }
}

// #endregion

// #region Annotations

const ANNOTATIONS_SUFFIX = '.annotations.json'

function getAnnotationsPath(kbId: string, docId: string): string {
  return path.join(getKbDir(kbId), `${docId}${ANNOTATIONS_SUFFIX}`)
}

async function readAnnotations(kbId: string, docId: string): Promise<KbDocAnnotation[]> {
  try {
    const raw = await fs.readFile(getAnnotationsPath(kbId, docId), 'utf-8')
    return JSON.parse(raw) as KbDocAnnotation[]
  } catch {
    return []
  }
}

async function writeAnnotations(kbId: string, docId: string, annotations: KbDocAnnotation[]): Promise<void> {
  await fs.mkdir(getKbDir(kbId), { recursive: true })
  await fs.writeFile(getAnnotationsPath(kbId, docId), JSON.stringify(annotations, null, 2), 'utf-8')
}

export async function listAnnotations(kbId: string, docId: string): Promise<KbDocAnnotation[]> {
  const annotations = await readAnnotations(kbId, docId)
  return annotations.sort((a, b) => a.startOffset - b.startOffset)
}

export async function createAnnotation(
  kbId: string,
  docId: string,
  text: string,
  startOffset: number,
  endOffset: number,
  content: string
): Promise<KbDocAnnotation> {
  const annotations = await readAnnotations(kbId, docId)
  const now = new Date().toISOString()
  const annotation: KbDocAnnotation = {
    id: uuidv4(),
    kbId,
    docId,
    text,
    startOffset,
    endOffset,
    content,
    createdAt: now,
    updatedAt: now
  }
  annotations.push(annotation)
  await writeAnnotations(kbId, docId, annotations)
  return annotation
}

export async function updateAnnotation(annotation: KbDocAnnotation): Promise<KbDocAnnotation> {
  const annotations = await readAnnotations(annotation.kbId, annotation.docId)
  const index = annotations.findIndex((item) => item.id === annotation.id)
  if (index === -1) throw new Error(`Annotation not found: ${annotation.id}`)
  const now = new Date().toISOString()
  // 仅允许修改批注文字，不可改动关联的高亮范围（text / startOffset / endOffset 保持原值）
  const updated: KbDocAnnotation = {
    ...annotations[index],
    content: annotation.content,
    updatedAt: now
  }
  annotations[index] = updated
  await writeAnnotations(annotation.kbId, annotation.docId, annotations)
  return updated
}

export async function deleteAnnotation(kbId: string, docId: string, id: string): Promise<boolean> {
  const annotations = await readAnnotations(kbId, docId)
  const filtered = annotations.filter((item) => item.id !== id)
  if (filtered.length === annotations.length) return false
  await writeAnnotations(kbId, docId, filtered)
  return true
}

// REQ-015 批注回复：在指定批注下追加一条回复。
export async function addAnnotationReply(
  kbId: string,
  docId: string,
  annotationId: string,
  content: string
): Promise<KbDocAnnotation | null> {
  const text = content.trim()
  if (!text) throw new Error('回复内容不能为空')
  const annotations = await readAnnotations(kbId, docId)
  const index = annotations.findIndex((item) => item.id === annotationId)
  if (index === -1) return null
  const now = new Date().toISOString()
  const reply: AnnotationReply = {
    id: uuidv4(),
    content: text,
    createdAt: now,
    updatedAt: now
  }
  const replies = [...(annotations[index].replies ?? []), reply]
  annotations[index] = { ...annotations[index], replies, updatedAt: now }
  await writeAnnotations(kbId, docId, annotations)
  return annotations[index]
}

// REQ-015 删除批注回复。
export async function deleteAnnotationReply(
  kbId: string,
  docId: string,
  annotationId: string,
  replyId: string
): Promise<KbDocAnnotation | null> {
  const annotations = await readAnnotations(kbId, docId)
  const index = annotations.findIndex((item) => item.id === annotationId)
  if (index === -1) return null
  const replies = (annotations[index].replies ?? []).filter((r) => r.id !== replyId)
  annotations[index] = { ...annotations[index], replies, updatedAt: new Date().toISOString() }
  await writeAnnotations(kbId, docId, annotations)
  return annotations[index]
}

export async function countAnnotations(kbId: string, docId: string): Promise<number> {
  const annotations = await readAnnotations(kbId, docId)
  return annotations.length
}

// 删除文档时清理批注文件（整文件删除，区别于 deleteAnnotation 的单条删除）
async function deleteAnnotationsFile(kbId: string, docId: string): Promise<boolean> {
  try {
    await fs.unlink(getAnnotationsPath(kbId, docId))
    return true
  } catch {
    return false
  }
}

// 删除文档时清理各类 sidecar 数据文件（.table.json / .database.json 等）
async function deleteSidecarFile(kbId: string, docId: string, suffix: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(getKbDir(kbId), `${docId}${suffix}`))
    return true
  } catch {
    return false
  }
}

// #endregion

// #region Todos

// 待办跨 Note / KB Doc 两类对象，统一存放在顶层 todos 目录下的单一集合文件，
// 便于「查看所有待办」时一次读取聚合，无需遍历 notes / kb 多级目录。
function getTodosFile(): string {
  return path.join(getTodosDir(), 'todos.json')
}

async function ensureTodosDir(): Promise<void> {
  await fs.mkdir(getTodosDir(), { recursive: true })
}

async function readTodos(): Promise<Todo[]> {
  await ensureTodosDir()
  try {
    const raw = await fs.readFile(getTodosFile(), 'utf-8')
    return JSON.parse(raw) as Todo[]
  } catch {
    return []
  }
}

async function writeTodos(todos: Todo[]): Promise<void> {
  await ensureTodosDir()
  await fs.writeFile(getTodosFile(), JSON.stringify(todos, null, 2), 'utf-8')
}

export async function listTodos(): Promise<Todo[]> {
  const todos = await readTodos()
  // 未完成（done=false）排在已完成之前；同组内按 updatedAt 倒序，与 notes/kb 一致
  return todos.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

export async function getTodo(id: string): Promise<Todo | null> {
  const todos = await readTodos()
  return todos.find((todo) => todo.id === id) ?? null
}

export async function createTodo(
  title: string,
  detail: string,
  targetType: TodoTargetType,
  targetId: string,
  kbId?: string
): Promise<Todo> {
  const todos = await readTodos()
  const now = new Date().toISOString()
  // targetId 为空时表示无关联待办；targetType 仍需合法值占位
  const todo: Todo = {
    id: uuidv4(),
    title: title.trim() || '未命名待办',
    detail: detail ?? '',
    done: false,
    targetType,
    targetId: targetId ?? '',
    ...(targetType === 'kbDoc' && targetId && kbId ? { kbId } : {}),
    createdAt: now,
    updatedAt: now
  }
  todos.push(todo)
  await writeTodos(todos)
  return todo
}

export async function saveTodo(todo: Todo): Promise<Todo> {
  const todos = await readTodos()
  const index = todos.findIndex((item) => item.id === todo.id)
  if (index === -1) throw new Error(`Todo not found: ${todo.id}`)
  const now = new Date().toISOString()
  // 仅允许修改标题/详情/完成状态，关联目标（targetType/targetId/kbId）保持原值，
  // 与批注「不可改高亮范围」理念一致。
  const updated: Todo = {
    ...todos[index],
    title: todo.title.trim() || '未命名待办',
    detail: todo.detail ?? '',
    done: todo.done,
    updatedAt: now
  }
  todos[index] = updated
  await writeTodos(todos)
  return updated
}

export async function deleteTodo(id: string): Promise<boolean> {
  const todos = await readTodos()
  const filtered = todos.filter((item) => item.id !== id)
  if (filtered.length === todos.length) return false
  await writeTodos(filtered)
  return true
}

// 删除指向指定目标的所有待办，供 deleteNote / deleteKbDoc 级联清理调用。
export async function deleteTodosByTarget(targetType: TodoTargetType, targetId: string): Promise<void> {
  const todos = await readTodos()
  const filtered = todos.filter(
    (item) => !(item.targetType === targetType && item.targetId === targetId)
  )
  if (filtered.length !== todos.length) {
    await writeTodos(filtered)
  }
}

export async function countTodos(): Promise<number> {
  const todos = await readTodos()
  return todos.length
}

// #endregion

// #region Links

async function findKbDocMetaById(docId: string): Promise<{ kbId: string; meta: KnowledgeBaseDocSummary } | null> {
  const kbs = await readKbMeta()
  for (const kb of kbs) {
    const docs = await readKbDocsMeta(kb.id)
    const meta = docs.find((doc) => doc.id === docId)
    if (meta) return { kbId: kb.id, meta }
  }
  return null
}

async function updateKbDocMeta(kbId: string, docId: string, updater: (meta: KnowledgeBaseDocSummary) => KnowledgeBaseDocSummary): Promise<void> {
  const docs = await readKbDocsMeta(kbId)
  const index = docs.findIndex((doc) => doc.id === docId)
  if (index === -1) return
  docs[index] = updater(docs[index])
  await writeKbDocsMeta(kbId, docs)
}

export async function addLink(noteId: string, kbDocId: string): Promise<void> {
  const note = await getNote(noteId)
  if (!note) throw new Error(`Note not found: ${noteId}`)

  const found = await findKbDocMetaById(kbDocId)
  if (!found) throw new Error(`KB doc not found: ${kbDocId}`)

  // Update note
  const noteLinks = new Set(note.linkedKbDocIds ?? [])
  noteLinks.add(kbDocId)
  note.linkedKbDocIds = Array.from(noteLinks)
  await saveNote(note)

  // Update doc meta
  await updateKbDocMeta(found.kbId, kbDocId, (meta) => {
    const docLinks = new Set(meta.linkedNoteIds ?? [])
    docLinks.add(noteId)
    return { ...meta, linkedNoteIds: Array.from(docLinks) }
  })
}

export async function removeLink(noteId: string, kbDocId: string): Promise<void> {
  const note = await getNote(noteId)
  if (!note) throw new Error(`Note not found: ${noteId}`)

  const found = await findKbDocMetaById(kbDocId)
  if (!found) throw new Error(`KB doc not found: ${kbDocId}`)

  // Update note
  note.linkedKbDocIds = (note.linkedKbDocIds ?? []).filter((id) => id !== kbDocId)
  await saveNote(note)

  // Update doc meta
  await updateKbDocMeta(found.kbId, kbDocId, (meta) => ({
    ...meta,
    linkedNoteIds: (meta.linkedNoteIds ?? []).filter((id) => id !== noteId)
  }))
}

export async function listLinksForNote(noteId: string): Promise<KnowledgeBaseDocSummary[]> {
  const note = await getNote(noteId)
  if (!note?.linkedKbDocIds?.length) return []

  const results: KnowledgeBaseDocSummary[] = []
  for (const docId of note.linkedKbDocIds) {
    const found = await findKbDocMetaById(docId)
    if (found) results.push(found.meta)
  }
  return results
}

export async function listLinksForDoc(kbDocId: string): Promise<NoteSummary[]> {
  const found = await findKbDocMetaById(kbDocId)
  if (!found?.meta.linkedNoteIds?.length) return []

  const results: NoteSummary[] = []
  for (const noteId of found.meta.linkedNoteIds) {
    const note = await getNote(noteId)
    if (note) {
      results.push({
        id: note.id,
        title: note.title || '无标题',
        summary: note.summary || generateSummary(note.content),
        updatedAt: note.updatedAt
      })
    }
  }
  return results
}

// #endregion

// #region Settings（应用设置，持久化到 {userData}/settings.json）

export function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

// 设置默认值。字段扩展时，缺失字段会被回填，保证向前兼容。
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  defaultEditorMode: 'wysiwyg',
  autoSaveDebounceMs: 500,
  maxHistoryVersions: 30,
  enableLineNumbers: false,
  enableSpellCheck: false, // REQ-113 默认关闭（避免对中文误报）
  enableAutoPair: true, // REQ-114 默认开启
  enableFocusMode: false, // REQ-107
  enableTypewriterMode: false, // REQ-107
  enableLint: false, // REQ-118 默认关闭，按需开启
  enablePlantUMLServer: false, // REQ-115 默认关闭（需 Java）
  diagramBackend: 'local', // REQ-115
  pandocPath: null, // REQ-119
  pandocArgs: [], // REQ-119
  pinnedItems: [], // REQ-110
  recentItems: [], // REQ-110
  commandHistory: [], // REQ-108
  favorites: [], // REQ-201
  appLock: null, // REQ-208
  searchHistory: [], // REQ-204
  ocrEnabled: false, // REQ-205 默认关闭（OCR 资源开销大，按需开启）
  quickNote: { enabled: true, shortcut: 'Ctrl+Shift+N', defaultGroupId: null }, // REQ-220
  localApi: { enabled: false, port: 0, token: '' }, // REQ-219 默认关闭；token 为空时首次启动生成
  webClip: { enabled: false, defaultGroupId: null }, // REQ-216 默认关闭
  ollama: { enabled: false, url: 'http://127.0.0.1:11434', model: '' } // REQ-215 默认关闭，模型为空时使用第一个可用
}

// 合并用户设置与默认值：对数组/对象字段做类型校验后回退默认，保证向前兼容。
export async function getSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return mergeSettings(parsed)
  } catch {
    // 文件不存在或损坏：返回默认设置（下次保存时再写入）
    return { ...DEFAULT_SETTINGS }
  }
}

function mergeSettings(parsed: Partial<AppSettings>): AppSettings {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && !Number.isNaN(v) ? v : d)
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  const arr = <T>(v: unknown, d: T[]): T[] => (Array.isArray(v) ? (v as T[]) : d.slice())
  return {
    theme: typeof parsed.theme === 'string' && parsed.theme ? parsed.theme : DEFAULT_SETTINGS.theme,
    defaultEditorMode: parsed.defaultEditorMode ?? DEFAULT_SETTINGS.defaultEditorMode,
    autoSaveDebounceMs: num(parsed.autoSaveDebounceMs, DEFAULT_SETTINGS.autoSaveDebounceMs),
    maxHistoryVersions: num(parsed.maxHistoryVersions, DEFAULT_SETTINGS.maxHistoryVersions),
    enableLineNumbers: bool(parsed.enableLineNumbers, DEFAULT_SETTINGS.enableLineNumbers),
    enableSpellCheck: bool(parsed.enableSpellCheck, DEFAULT_SETTINGS.enableSpellCheck),
    enableAutoPair: bool(parsed.enableAutoPair, DEFAULT_SETTINGS.enableAutoPair),
    enableFocusMode: bool(parsed.enableFocusMode, DEFAULT_SETTINGS.enableFocusMode),
    enableTypewriterMode: bool(parsed.enableTypewriterMode, DEFAULT_SETTINGS.enableTypewriterMode),
    enableLint: bool(parsed.enableLint, DEFAULT_SETTINGS.enableLint),
    enablePlantUMLServer: bool(parsed.enablePlantUMLServer, DEFAULT_SETTINGS.enablePlantUMLServer),
    diagramBackend: 'local',
    pandocPath: typeof parsed.pandocPath === 'string' ? parsed.pandocPath : DEFAULT_SETTINGS.pandocPath,
    pandocArgs: arr<string>(parsed.pandocArgs, DEFAULT_SETTINGS.pandocArgs ?? []),
    pinnedItems: arr<PinnedItem>(parsed.pinnedItems, DEFAULT_SETTINGS.pinnedItems ?? []),
    recentItems: arr<RecentItem>(parsed.recentItems, DEFAULT_SETTINGS.recentItems ?? []),
    commandHistory: arr<string>(parsed.commandHistory, DEFAULT_SETTINGS.commandHistory ?? []),
    favorites: arr<FavoriteItem>(parsed.favorites, DEFAULT_SETTINGS.favorites ?? []),
    appLock: normalizeAppLock(parsed.appLock),
    searchHistory: arr<SearchHistoryItem>(parsed.searchHistory, DEFAULT_SETTINGS.searchHistory ?? []),
    ocrEnabled: bool(parsed.ocrEnabled, DEFAULT_SETTINGS.ocrEnabled ?? false),
    quickNote: normalizeQuickNote(parsed.quickNote),
    localApi: normalizeLocalApi(parsed.localApi),
    webClip: normalizeWebClip(parsed.webClip),
    ollama: normalizeOllama(parsed.ollama)
  }
}

// REQ-215 校验 ollama 结构
function normalizeOllama(v: unknown): { enabled: boolean; url: string; model: string } {
  const d = DEFAULT_SETTINGS.ollama!
  if (!v || typeof v !== 'object') return { ...d }
  const o = v as Partial<{ enabled: boolean; url: string; model: string }>
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    url: typeof o.url === 'string' && o.url ? o.url : d.url,
    model: typeof o.model === 'string' ? o.model : d.model
  }
}

// REQ-216 校验 webClip 结构
function normalizeWebClip(v: unknown): { enabled: boolean; defaultGroupId: string | null } {
  const d = DEFAULT_SETTINGS.webClip!
  if (!v || typeof v !== 'object') return { ...d }
  const w = v as Partial<{ enabled: boolean; defaultGroupId: string | null }>
  return {
    enabled: typeof w.enabled === 'boolean' ? w.enabled : d.enabled,
    defaultGroupId:
      typeof w.defaultGroupId === 'string' ? w.defaultGroupId : w.defaultGroupId === null ? null : d.defaultGroupId
  }
}

// REQ-219 校验 localApi 结构；token 为空时生成一个随机 token
function normalizeLocalApi(v: unknown): { enabled: boolean; port: number; token: string } {
  const d = DEFAULT_SETTINGS.localApi!
  if (!v || typeof v !== 'object') {
    return { enabled: d.enabled, port: d.port, token: crypto.randomBytes(16).toString('hex') }
  }
  const a = v as Partial<{ enabled: boolean; port: number; token: string }>
  const token = typeof a.token === 'string' && a.token ? a.token : crypto.randomBytes(16).toString('hex')
  return {
    enabled: typeof a.enabled === 'boolean' ? a.enabled : d.enabled,
    port: typeof a.port === 'number' && a.port >= 0 && a.port <= 65535 ? a.port : d.port,
    token
  }
}

// REQ-220 校验 quickNote 结构
function normalizeQuickNote(v: unknown): { enabled: boolean; shortcut: string; defaultGroupId: string | null } {
  const d = DEFAULT_SETTINGS.quickNote!
  if (!v || typeof v !== 'object') return { ...d }
  const q = v as Partial<{ enabled: boolean; shortcut: string; defaultGroupId: string | null }>
  return {
    enabled: typeof q.enabled === 'boolean' ? q.enabled : d.enabled,
    shortcut: typeof q.shortcut === 'string' && q.shortcut ? q.shortcut : d.shortcut,
    defaultGroupId: typeof q.defaultGroupId === 'string' ? q.defaultGroupId : q.defaultGroupId === null ? null : d.defaultGroupId
  }
}

// REQ-208 校验 appLock 结构；非法时回退 null（关闭锁屏）。
function normalizeAppLock(v: unknown): AppLockConfig | null {
  if (!v || typeof v !== 'object') return null
  const cfg = v as Partial<AppLockConfig>
  if (
    cfg.enabled &&
    typeof cfg.passwordHash === 'string' &&
    cfg.passwordHash &&
    typeof cfg.salt === 'string' &&
    cfg.salt
  ) {
    return {
      enabled: true,
      passwordHash: cfg.passwordHash,
      salt: cfg.salt,
      algorithm: 'pbkdf2',
      iterations: typeof cfg.iterations === 'number' ? cfg.iterations : APP_LOCK_ITERATIONS
    }
  }
  return null
}

export async function saveSettings(settings: AppSettings): Promise<boolean> {
  try {
    await fs.writeFile(
      getSettingsPath(),
      JSON.stringify(settings, null, 2),
      'utf-8'
    )
    return true
  } catch {
    return false
  }
}

// #endregion

// #endregion

// #region REQ-006 文档层级：移动 / 重排序

export async function moveKbDoc(
  kbId: string,
  docId: string,
  parentId: string | null,
  order: number
): Promise<boolean> {
  const docs = await readKbDocsMeta(kbId)
  const index = docs.findIndex((d) => d.id === docId)
  if (index === -1) return false
  docs[index] = {
    ...docs[index],
    parentId: parentId ?? null,
    order,
    updatedAt: new Date().toISOString()
  }
  await writeKbDocsMeta(kbId, docs)
  return true
}

export async function reorderKbDocs(kbId: string, orderedIds: string[]): Promise<boolean> {
  const docs = await readKbDocsMeta(kbId)
  const byId = new Map(docs.map((d) => [d.id, d]))
  // 仅重排存在于列表中的文档；其余保持原序追加在后
  const reordered: KnowledgeBaseDocSummary[] = []
  orderedIds.forEach((id, i) => {
    const d = byId.get(id)
    if (d) {
      reordered.push({ ...d, order: i })
      byId.delete(id)
    }
  })
  let tail = docs.length
  for (const remaining of byId.values()) {
    reordered.push({ ...remaining, order: tail++ })
  }
  await writeKbDocsMeta(kbId, reordered)
  return true
}

// #endregion

// #region REQ-004/016 资源管理（图片 / 附件）

export function getAssetsDir(): string {
  return path.join(app.getPath('userData'), 'assets')
}

function getAssetScopeDir(scope: 'note' | 'kb', ownerId: string): string {
  // scope=note → assets/notes/{noteId}；scope=kb → assets/knowledge-bases/{kbId}
  const sub = scope === 'note' ? path.join('notes', ownerId) : path.join('knowledge-bases', ownerId)
  return path.join(getAssetsDir(), sub)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

// 将相对资源路径（assets/ 下）转换为 noteweave-asset:// 协议 URL。
export function assetRelativePathToUrl(rel: string): string {
  const norm = rel.replace(/\\/g, '/')
  return `noteweave-asset:///${norm}`
}

export async function saveImageAsset(
  scope: 'note' | 'kb',
  ownerId: string,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const dir = getAssetScopeDir(scope, ownerId)
  await ensureDir(dir)
  const stamp = Date.now()
  const rnd = Math.random().toString(36).slice(2, 8)
  const safeExt = (ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'png'
  const fileName = `${stamp}-${rnd}.${safeExt}`
  const abs = path.join(dir, fileName)
  await fs.writeFile(abs, buffer)
  // 返回 noteweave-asset:// URL，由主进程协议解析为本地文件
  const rel = path.relative(getAssetsDir(), abs).replace(/\\/g, '/')
  const url = assetRelativePathToUrl(rel)
  // REQ-205 异步触发 OCR（不阻塞保存；仅当用户开启 OCR 时）
  triggerOcrIfEnabled(url).catch(() => {})
  return url
}

// REQ-205 若用户在设置中开启 OCR，则后台异步对刚保存的图片做 OCR 并缓存文本。
async function triggerOcrIfEnabled(assetUrl: string): Promise<void> {
  try {
    const settings = await getSettings()
    if (!settings.ocrEnabled) return
    const { ocrImageByUrl } = await import('./ocr')
    await ocrImageByUrl(assetUrl)
  } catch {
    // OCR 失败不影响图片保存
  }
}

export async function saveAttachmentAsset(
  scope: 'note' | 'kb',
  ownerId: string,
  buffer: Buffer,
  name: string
): Promise<string> {
  const dir = path.join(getAssetScopeDir(scope, ownerId), 'attachments')
  await ensureDir(dir)
  const stamp = Date.now()
  const rnd = Math.random().toString(36).slice(2, 6)
  const safe = (name || `attachment-${stamp}`).replace(/[\\/:*?"<>|]/g, '_')
  const fileName = `${stamp}-${rnd}-${safe}`
  const abs = path.join(dir, fileName)
  await fs.writeFile(abs, buffer)
  const rel = path.relative(getAssetsDir(), abs).replace(/\\/g, '/')
  return assetRelativePathToUrl(rel)
}

export async function listAssets(scope: 'note' | 'kb', ownerId: string): Promise<AssetItem[]> {  const dir = getAssetScopeDir(scope, ownerId)
  const items: AssetItem[] = []
  async function walk(d: string) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(d)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry)
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        await walk(full)
      } else {
        const rel = path.relative(getAssetsDir(), full).replace(/\\/g, '/')
        items.push({
          name: entry,
          url: assetRelativePathToUrl(rel),
          size: stat.size,
          createdAt: stat.mtime.toISOString()
        })
      }
    }
  }
  await walk(dir)
  return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

// 按 URL 删除资源（解析协议为本地路径后删除文件）。
export async function deleteAssetByUrl(url: string): Promise<boolean> {
  try {
    const abs = assetUrlToAbs(url)
    await fs.unlink(abs)
    return true
  } catch {
    return false
  }
}

// REQ-004：把 noteweave-asset:// URL 解析为本地绝对路径（资源必须位于 assets 目录内）。
export function assetUrlToAbs(url: string): string {
  const rel = url.replace(/^noteweave-asset:\/\/\/?/, '').replace(/^assets\//, '')
  return path.join(getAssetsDir(), rel)
}

// REQ-004：从一段文本中提取其引用的资源相对路径集合。
export function extractAssetRelsFromText(text: string): string[] {
  const re = /noteweave-asset:\/\/\/?([^)\s"']+)/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let rel = decodeURIComponent(m[1])
    if (rel.startsWith('assets/')) rel = rel.slice('assets/'.length)
    out.push(rel.replace(/\\/g, '/'))
  }
  return out
}

// REQ-004：找出「仅被指定文档/笔记引用」的资源 URL 列表。
// 即：从 content 提取的引用中，排除被其它 note/kbDoc 也引用的，剩下的为独占资源，
// 删除该文档时这些资源可安全清理。
export async function findExclusiveAssets(
  target:
    | { kind: 'note'; noteId: string; content: string }
    | { kind: 'kbDoc'; kbId: string; docId: string; content: string }
): Promise<string[]> {
  const ownRels = new Set(extractAssetRelsFromText(target.content))
  if (ownRels.size === 0) return []

  // 收集其它文档/笔记的引用。
  const others = new Set<string>()

  // Notes（排除当前 note）
  try {
    const files = await fs.readdir(getNotesDir())
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'groups.json') continue
      if (target.kind === 'note' && file === `${target.noteId}.json`) continue
      try {
        const raw = JSON.parse(await fs.readFile(path.join(getNotesDir(), file), 'utf-8')) as Note
        for (const rel of extractAssetRelsFromText(raw.content ?? '')) others.add(rel)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // KB Docs（排除当前 doc）
  try {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        if (target.kind === 'kbDoc' && kb.id === target.kbId && doc.id === target.docId) continue
        try {
          const content = await fs.readFile(getKbDocContentPath(kb.id, doc.id), 'utf-8')
          for (const rel of extractAssetRelsFromText(content)) others.add(rel)
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  const exclusive: string[] = []
  for (const rel of ownRels) {
    if (!others.has(rel)) {
      exclusive.push(`noteweave-asset:///${rel}`)
    }
  }
  return exclusive
}

// 收集所有 Note / KB Doc 内容中引用的 noteweave-asset:// 资源相对路径。
async function collectReferencedAssetRels(): Promise<Set<string>> {
  const referenced = new Set<string>()
  const extract = (text: string) => {
    for (const rel of extractAssetRelsFromText(text)) referenced.add(rel)
  }

  // Notes
  try {
    const files = await fs.readdir(getNotesDir())
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'groups.json') continue
      try {
        const note = JSON.parse(await fs.readFile(path.join(getNotesDir(), file), 'utf-8')) as Note
        extract(note.content ?? '')
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // KB Docs
  try {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        try {
          const content = await fs.readFile(getKbDocContentPath(kb.id, doc.id), 'utf-8')
          extract(content)
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return referenced
}

// REQ-004：清理未被任何文档引用的资源文件。返回删除数量。
export async function pruneOrphanAssets(): Promise<number> {
  const referenced = await collectReferencedAssetRels()
  const base = getAssetsDir()
  let removed = 0
  async function walk(dir: string) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        await walk(full)
      } else {
        const rel = path.relative(base, full).replace(/\\/g, '/')
        if (!referenced.has(rel)) {
          try {
            await fs.unlink(full)
            removed++
          } catch {
            // ignore
          }
        }
      }
    }
  }
  await walk(base)
  return removed
}

// REQ-004：列出全部资源（遍历 notes/ 与 knowledge-bases/ 下所有 owner 目录），
// 供资源管理面板展示。返回带 scope/ownerId 的条目。
export interface AssetEntry extends AssetItem {
  scope: 'note' | 'kb'
  ownerId: string
}

export async function listAllAssets(): Promise<AssetEntry[]> {
  const base = getAssetsDir()
  const out: AssetEntry[] = []
  async function walk(dir: string, scope: 'note' | 'kb' | null, ownerId: string | null) {
    let entries: string[] = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        // assets/notes/{ownerId} 或 assets/knowledge-bases/{ownerId}
        let nextScope = scope
        let nextOwner = ownerId
        if (scope === null && entry === 'notes') nextScope = 'note'
        else if (scope === null && entry === 'knowledge-bases') nextScope = 'kb'
        else if (scope === 'note' && ownerId === null) nextOwner = entry
        else if (scope === 'kb' && ownerId === null) nextOwner = entry
        walk(full, nextScope, nextOwner)
      } else if (scope && ownerId) {
        const rel = path.relative(base, full).replace(/\\/g, '/')
        out.push({
          name: entry,
          url: assetRelativePathToUrl(rel),
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
          scope,
          ownerId
        })
      }
    }
  }
  await walk(base, null, null)
  return out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

// #endregion

// #region REQ-005 全文搜索（实时遍历，无持久化索引；数据量适中场景）

// 转义正则元字符，构建不区分大小写的匹配；同时计算高亮片段。
function buildSnippet(text: string, query: string, radius = 40): string {
  if (!text) return ''
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) {
    // 标题命中但正文未命中时，返回正文头部摘要
    return escapeHtml(text.slice(0, radius * 2))
  }
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + query.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const before = escapeHtml(text.slice(start, idx))
  const match = escapeHtml(text.slice(idx, idx + query.length))
  const after = escapeHtml(text.slice(idx + query.length, end))
  return `${prefix}${before}<mark class="search-mark">${match}</mark>${after}${suffix}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export async function search(keyword: string, options?: {
  filters?: SearchHitType[]
  dateFrom?: string
  dateTo?: string
  sortBy?: 'updatedAt' | 'relevance'
  kbIds?: string[]
  tags?: string[]
}): Promise<SearchResult[]> {
  const query = keyword.trim().toLowerCase()
  if (!query) return []
  const filters = options?.filters ?? []
  const active = new Set(
    filters.length ? filters : (['note', 'kbDoc', 'todo', 'annotation', 'comment', 'image'] as SearchHitType[])
  )
  const from = options?.dateFrom ? new Date(options.dateFrom).getTime() : undefined
  const to = options?.dateTo ? new Date(options.dateTo).getTime() : undefined
  const sortBy = options?.sortBy ?? 'updatedAt'
  const kbIdSet = options?.kbIds && options.kbIds.length ? new Set(options.kbIds) : null
  const tagSet = options?.tags && options.tags.length ? new Set(options.tags.map((t) => t.toLowerCase())) : null

  const matchesKb = (kbId?: string): boolean => !kbIdSet || (kbId ? kbIdSet.has(kbId) : false)
  const matchesTags = (tags?: string[]): boolean =>
    !tagSet || (tags ? tags.some((t) => tagSet.has(t.toLowerCase())) : false)

  const inRange = (iso?: string): boolean => {
    if (!iso) return true
    const t = new Date(iso).getTime()
    if (from !== undefined && t < from) return false
    if (to !== undefined && t > to) return false
    return true
  }

  // 命中次数（用于相关度排序）
  const countOccur = (hay: string): number => {
    if (!hay) return 0
    let count = 0
    let idx = hay.toLowerCase().indexOf(query)
    while (idx !== -1) {
      count++
      idx = hay.toLowerCase().indexOf(query, idx + query.length)
    }
    return count
  }

  const results: SearchResult[] = []

  const push = (r: SearchResult, matchText: string, hayForScore: string) => {
    if (!inRange(r.updatedAt)) return
    r.score = countOccur(hayForScore) + (matchText.toLowerCase().includes(query) ? 0 : 0)
    r.matchText = query
    results.push(r)
  }

  if (active.has('note')) {
    const notes = await listNotes()
    for (const summary of notes) {
      if (!matchesTags(summary.tags)) continue
      let content = ''
      let matched = false
      const hay = `${summary.title}\n${summary.summary}\n${(summary.tags ?? []).join(' ')}`
      if (hay.toLowerCase().includes(query)) matched = true
      if (!matched) {
        const note = await getNote(summary.id)
        if (note && note.content.toLowerCase().includes(query)) {
          matched = true
          content = note.content
        }
      } else {
        const note = await getNote(summary.id)
        content = note?.content ?? summary.summary
      }
      if (matched) {
        push(
          {
            type: 'note',
            id: summary.id,
            title: summary.title || '无标题',
            snippet: buildSnippet(content || summary.summary, query),
            updatedAt: summary.updatedAt
          },
          content || summary.summary,
          `${hay}\n${content}`
        )
      }
    }
  }

  if (active.has('kbDoc')) {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      if (!matchesKb(kb.id)) continue
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        if (!matchesTags(doc.tags)) continue
        let matched = false
        const nameHay = `${doc.name}\n${(doc.tags ?? []).join(' ')}`
        if (nameHay.toLowerCase().includes(query)) matched = true
        let content = ''
        try {
          content = await fs.readFile(getKbDocContentPath(kb.id, doc.id), 'utf-8')
        } catch {
          content = ''
        }
        if (!matched && content.toLowerCase().includes(query)) matched = true
        if (matched) {
          push(
            {
              type: 'kbDoc',
              id: doc.id,
              kbId: kb.id,
              docId: doc.id,
              title: doc.name || '未命名文档',
              snippet: buildSnippet(content, query),
              updatedAt: doc.updatedAt
            },
            content,
            `${nameHay}\n${content}`
          )
        }
      }
    }
  }

  if (active.has('todo')) {
    const todos = await readTodos()
    for (const todo of todos) {
      const full = `${todo.title}\n${todo.detail}`
      if (full.toLowerCase().includes(query)) {
        push(
          {
            type: 'todo',
            id: todo.id,
            title: todo.title || '未命名待办',
            snippet: buildSnippet(full, query),
            updatedAt: todo.updatedAt
          },
          full,
          full
        )
      }
    }
  }

  if (active.has('annotation')) {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      if (!matchesKb(kb.id)) continue
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        const anns = await readAnnotations(kb.id, doc.id)
        for (const ann of anns) {
          const full = `${ann.text}\n${ann.content}`
          if (full.toLowerCase().includes(query)) {
            push(
              {
                type: 'annotation',
                id: ann.id,
                kbId: kb.id,
                docId: doc.id,
                title: `批注 · ${doc.name || '未命名文档'}`,
                snippet: buildSnippet(full, query),
                updatedAt: ann.updatedAt
              },
              full,
              full
            )
          }
        }
      }
    }
  }

  if (active.has('comment')) {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      if (!matchesKb(kb.id)) continue
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        const comments = await readComments(kb.id, doc.id)
        for (const c of comments) {
          const full = c.content
          if (full.toLowerCase().includes(query)) {
            push(
              {
                type: 'comment',
                id: c.id,
                kbId: kb.id,
                docId: doc.id,
                title: `评论 · ${doc.name || '未命名文档'}`,
                snippet: buildSnippet(full, query),
                updatedAt: c.updatedAt
              },
              full,
              full
            )
          }
        }
      }
    }
  }

  if (active.has('image')) {
    // REQ-205 图片 OCR 搜索：扫描 OCR 缓存文本，命中时返回「图片」类型结果
    try {
      const { loadAllOcrTexts } = await import('./ocr')
      const { relToAssetUrl } = await import('../shared/ocr-helpers')
      const ocrMap = await loadAllOcrTexts()
      // 同时读取图片资源创建时间用于排序
      const assetStats = new Map<string, string>()
      try {
        const all = await listAllAssets()
        for (const a of all) {
          const rel = extractAssetRelsFromText(`![](${a.url})`)[0]
          if (rel) assetStats.set(rel, a.createdAt)
        }
      } catch {
        // ignore
      }
      for (const [rel, text] of ocrMap) {
        if (!text.toLowerCase().includes(query)) continue
        const url = relToAssetUrl(rel)
        results.push({
          type: 'image',
          id: rel,
          title: `图片 · ${rel.split('/').pop() ?? rel}`,
          snippet: buildSnippet(text, query),
          updatedAt: assetStats.get(rel),
          score: (text.toLowerCase().split(query).length - 1) || 1,
          matchText: query,
          // 通过 docId 字段携带图片 URL，便于结果点击时定位
          docId: url
        } as SearchResult)
      }
    } catch {
      // OCR 模块不可用时静默跳过图片搜索
    }
  }

  if (sortBy === 'relevance') {
    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }
  return results.sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
  )
}

// #endregion

// #region REQ-013 回收站（软删除 + 恢复）

export function getTrashDir(): string {
  return path.join(app.getPath('userData'), 'trash')
}

function getTrashFile(): string {
  return path.join(getTrashDir(), 'trash.json')
}

async function readTrash(): Promise<TrashItem[]> {
  await ensureDir(getTrashDir())
  try {
    const raw = await fs.readFile(getTrashFile(), 'utf-8')
    return JSON.parse(raw) as TrashItem[]
  } catch {
    return []
  }
}

async function writeTrash(items: TrashItem[]): Promise<void> {
  await ensureDir(getTrashDir())
  await fs.writeFile(getTrashFile(), JSON.stringify(items, null, 2), 'utf-8')
}

export async function listTrash(): Promise<TrashSummary[]> {
  const items = await readTrash()
  return items
    .map((it) => ({
      id: it.id,
      kind: it.kind,
      originalId: it.originalId,
      kbId: it.kbId,
      name: it.name,
      deletedAt: it.deletedAt
    }))
    .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime())
}

// 将一项转入回收站（记录原始 payload 供恢复）。
export async function moveToTrash(item: Omit<TrashItem, 'id' | 'deletedAt'>): Promise<void> {
  const items = await readTrash()
  items.push({ ...item, id: uuidv4(), deletedAt: new Date().toISOString() })
  await writeTrash(items)
}

export async function restoreTrash(id: string): Promise<boolean> {
  const items = await readTrash()
  const idx = items.findIndex((it) => it.id === id)
  if (idx === -1) return false
  const item = items[idx]
  try {
    if (item.kind === 'note') {
      const note = item.payload as Note
      await fs.writeFile(getNotePath(note.id), JSON.stringify(note, null, 2), 'utf-8')
    } else if (item.kind === 'kbDoc') {
      const doc = item.payload as KnowledgeBaseDoc
      await fs.mkdir(getKbDir(doc.kbId), { recursive: true })
      const docs = await readKbDocsMeta(doc.kbId)
      if (!docs.find((d) => d.id === doc.id)) {
        docs.push({
          id: doc.id,
          kbId: doc.kbId,
          name: doc.name,
          createdAt: doc.createdAt,
          updatedAt: new Date().toISOString(),
          linkedNoteIds: doc.linkedNoteIds ?? [],
          parentId: doc.parentId ?? null,
          order: doc.order ?? 0,
          tags: doc.tags ?? [],
          locked: doc.locked ?? false,
          feedback: doc.feedback ?? null,
          docType: doc.docType ?? 'markdown'
        })
        await writeKbDocsMeta(doc.kbId, docs)
      }
      await fs.writeFile(getKbDocContentPath(doc.kbId, doc.id), doc.content, 'utf-8')
    } else if (item.kind === 'knowledgeBase') {
      const kb = item.payload as KnowledgeBase & { _docsSnapshot?: KnowledgeBaseDocSummary[] }
      const kbs = await readKbMeta()
      if (!kbs.find((k) => k.id === kb.id)) {
        kbs.push({
          id: kb.id,
          name: kb.name,
          category: kb.category,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt
        })
        await writeKbMeta(kbs)
      }
      // 重建知识库目录与 meta.json。
      await fs.mkdir(getKbDir(kb.id), { recursive: true })
      await writeKbDocsMeta(kb.id, kb._docsSnapshot ?? [])
      // REQ-013 级联恢复：删除知识库时其下每篇文档已作为独立 kbDoc 条目进入回收站。
      // 此处一并从回收站找回这些文档条目，写回 content 文件并清理 trash，避免用户逐条恢复。
      const consumedTrashIds = new Set<string>()
      for (const summary of kb._docsSnapshot ?? []) {
        const docItem = items.find(
          (it) =>
            it.kind === 'kbDoc' &&
            it.originalId === summary.id &&
            it.kbId === kb.id
        )
        if (!docItem) continue
        const doc = docItem.payload as KnowledgeBaseDoc
        try {
          await fs.writeFile(getKbDocContentPath(kb.id, summary.id), doc.content, 'utf-8')
          consumedTrashIds.add(docItem.id)
        } catch {
          // 单篇文档恢复失败不阻断整体，用户仍可从回收站单独恢复。
        }
      }
      // 将已级联恢复的 kbDoc 条目从回收站移除。
      if (consumedTrashIds.size > 0) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (consumedTrashIds.has(items[i].id)) items.splice(i, 1)
        }
      }
    }
    items.splice(idx, 1)
    await writeTrash(items)
    return true
  } catch {
    return false
  }
}

export async function deleteTrash(id: string): Promise<boolean> {
  const items = await readTrash()
  const filtered = items.filter((it) => it.id !== id)
  if (filtered.length === items.length) return false
  await writeTrash(filtered)
  return true
}

export async function emptyTrash(): Promise<boolean> {
  await writeTrash([])
  return true
}

// #endregion

// #region REQ-014 版本历史

export function getHistoryBaseDir(): string {
  return path.join(app.getPath('userData'), 'history')
}

function getHistoryScopeDir(scope: 'note' | 'kbDoc', refId: string): string {
  const sub = scope === 'note' ? 'notes' : 'kbDocs'
  return path.join(getHistoryBaseDir(), sub, refId)
}

async function readHistoryIndex(scope: 'note' | 'kbDoc', refId: string): Promise<HistoryItem[]> {
  try {
    const raw = await fs.readFile(path.join(getHistoryScopeDir(scope, refId), 'index.json'), 'utf-8')
    return JSON.parse(raw) as HistoryItem[]
  } catch {
    return []
  }
}

async function writeHistoryIndex(scope: 'note' | 'kbDoc', refId: string, items: HistoryItem[]): Promise<void> {
  const dir = getHistoryScopeDir(scope, refId)
  await ensureDir(dir)
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify(items, null, 2), 'utf-8')
}

export async function listHistory(scope: 'note' | 'kbDoc', refId: string): Promise<HistorySummary[]> {
  const items = await readHistoryIndex(scope, refId)
  return items
    .map((it) => ({
      id: it.id,
      scope: it.scope,
      refId: it.refId,
      savedAt: it.savedAt,
      length: it.content.length
    }))
    .sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())
}

export async function getHistory(id: string): Promise<HistoryItem | null> {
  // id 形如 {refId}_{timestamp}；为简化，直接遍历所有 history 目录查找。
  try {
    const base = getHistoryBaseDir()
    for (const sub of ['notes', 'kbDocs']) {
      const scopeDir = path.join(base, sub)
      let refs: string[] = []
      try {
        refs = await fs.readdir(scopeDir)
      } catch {
        continue
      }
      const scope = sub === 'notes' ? 'note' : 'kbDoc'
      for (const ref of refs) {
        const items = await readHistoryIndex(scope, ref)
        const found = items.find((it) => it.id === id)
        if (found) return found
      }
    }
  } catch {
    // ignore
  }
  return null
}

// 保存一个历史快照（仅在内容相对上一个快照发生变化时）。
export async function saveHistorySnapshot(
  scope: 'note' | 'kbDoc',
  refId: string,
  content: string
): Promise<boolean> {
  const settings = await getSettings()
  const max = typeof settings.maxHistoryVersions === 'number' && settings.maxHistoryVersions > 0
    ? settings.maxHistoryVersions
    : 30
  const items = await readHistoryIndex(scope, refId)
  // 与最近一份内容相同则跳过
  const latest = items[items.length - 1]
  if (latest && latest.content === content) return false
  const now = new Date().toISOString()
  const item: HistoryItem = {
    id: `${refId}_${now}`,
    scope,
    refId,
    content,
    savedAt: now
  }
  items.push(item)
  // 保留最近 max 条
  const trimmed = items.slice(-max)
  await writeHistoryIndex(scope, refId, trimmed)
  return true
}

// #endregion

// #region REQ-011 文档模板

export function getTemplatesDir(): string {
  return path.join(app.getPath('userData'), 'templates')
}

function getTemplateFile(id: string): string {
  return path.join(getTemplatesDir(), `${id}.json`)
}

// 内置模板（仅当用户模板库为空时提供初始集合）。
const BUILTIN_TEMPLATES: TemplateDoc[] = [
  {
    id: 'builtin-meeting',
    name: '会议纪要',
    content: `# 会议纪要\n\n- 时间：\n- 参会人：\n\n## 议题\n\n1. \n2. \n\n## 决议\n\n- \n\n## 待办\n\n- [ ] \n`,
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'builtin-requirement',
    name: '需求文档',
    content: `# 需求文档\n\n## 背景\n\n\n## 目标\n\n\n## 功能点\n\n### \n\n## 验收标准\n\n- \n`,
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'builtin-weekly',
    name: '周报',
    content: `# 本周周报\n\n## 本周完成\n\n- \n\n## 下周计划\n\n- \n\n## 风险与思考\n\n- \n`,
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'builtin-reading',
    name: '读书笔记',
    content: `# {{书名}}\n\n## 基本信息\n\n- 作者：\n- 读完：\n- 评分：⭐⭐⭐⭐⭐\n\n## 摘录\n\n\n## 心得\n\n\n## 行动\n\n- \n`,
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'builtin-project',
    name: '项目方案',
    content: `# {{项目名}} 项目方案\n\n## 背景与目标\n\n\n## 范围\n\n- 包含：\n- 不包含：\n\n## 方案设计\n\n### \n\n\n## 里程碑\n\n- \n\n## 风险与对策\n\n- \n`,
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'builtin-blank',
    name: '空白文档',
    content: '',
    builtin: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
]

export async function listTemplates(): Promise<TemplateDoc[]> {
  await ensureDir(getTemplatesDir())
  const userTemplates: TemplateDoc[] = []
  try {
    const files = await fs.readdir(getTemplatesDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(getTemplatesDir(), file), 'utf-8')
        userTemplates.push(JSON.parse(raw) as TemplateDoc)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  userTemplates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return [...userTemplates, ...BUILTIN_TEMPLATES]
}

export async function saveTemplate(name: string, content: string): Promise<TemplateDoc> {
  await ensureDir(getTemplatesDir())
  const now = new Date().toISOString()
  const tpl: TemplateDoc = {
    id: uuidv4(),
    name: name.trim() || '自定义模板',
    content,
    builtin: false,
    createdAt: now,
    updatedAt: now
  }
  await fs.writeFile(getTemplateFile(tpl.id), JSON.stringify(tpl, null, 2), 'utf-8')
  return tpl
}

export async function deleteTemplate(id: string): Promise<boolean> {
  try {
    await fs.unlink(getTemplateFile(id))
    return true
  } catch {
    return false
  }
}

// #endregion

// #region REQ-111 自定义主题（{userData}/themes/*.css）

export function getThemesDir(): string {
  return path.join(app.getPath('userData'), 'themes')
}

function getThemeFile(id: string): string {
  return path.join(getThemesDir(), `${id}.json`)
}

// 内置主题（不可编辑/删除）。
const BUILTIN_THEMES: ThemeSummary[] = [
  { id: 'light', name: '亮色', builtin: true, isDark: false },
  { id: 'dark', name: '暗色', builtin: true, isDark: true },
  { id: 'system', name: '跟随系统', builtin: true }
]

export async function listThemes(): Promise<ThemeSummary[]> {
  const user: ThemeSummary[] = []
  try {
    const files = await fs.readdir(getThemesDir())
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(getThemesDir(), file), 'utf-8')
        const t = JSON.parse(raw) as ThemeDoc
        user.push({
          id: t.id,
          name: t.name,
          builtin: false,
          isDark: t.isDark
        })
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return [...BUILTIN_THEMES, ...user]
}

export async function getTheme(id: string): Promise<ThemeDoc | null> {
  try {
    const raw = await fs.readFile(getThemeFile(id), 'utf-8')
    return JSON.parse(raw) as ThemeDoc
  } catch {
    return null
  }
}

export async function saveTheme(theme: {
  id?: string
  name: string
  css: string
  isDark?: boolean
}): Promise<ThemeDoc> {
  await ensureDir(getThemesDir())
  const now = new Date().toISOString()
  const id = theme.id ?? uuidv4()
  const existing = theme.id ? await getTheme(theme.id) : null
  const doc: ThemeDoc = {
    id,
    name: theme.name.trim() || '未命名主题',
    builtin: false,
    isDark: theme.isDark ?? existing?.isDark ?? false,
    css: theme.css,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await fs.writeFile(getThemeFile(id), JSON.stringify(doc, null, 2), 'utf-8')
  return doc
}

export async function deleteTheme(id: string): Promise<boolean> {
  try {
    await fs.unlink(getThemeFile(id))
    return true
  } catch {
    return false
  }
}

// 解析主题名对应的 CSS：内置主题返回空串（由应用自身样式驱动），自定义主题返回其 CSS。
export async function resolveThemeCss(name: string): Promise<string | null> {
  if (!name || BUILTIN_THEMES.some((t) => t.id === name)) return ''
  const t = await getTheme(name)
  return t ? t.css : null
}

// #endregion

// #region REQ-110 最近 / 固定文件（写入 settings.json）

export async function recordRecentItem(item: {
  kind: 'note' | 'kbDoc'
  id: string
  kbId?: string
  title: string
}): Promise<RecentItem[]> {
  const settings = await getSettings()
  const now = new Date().toISOString()
  // 去重：同 kind+id 视为同一项，更新时间与标题
  const filtered = settings.recentItems.filter(
    (r) => !(r.kind === item.kind && r.id === item.id)
  )
  const entry: RecentItem = {
    kind: item.kind,
    id: item.id,
    kbId: item.kbId,
    title: item.title,
    openedAt: now
  }
  const recentItems = [entry, ...filtered].slice(0, 20)
  await saveSettings({ ...settings, recentItems })
  return recentItems
}

export async function pinItem(item: {
  kind: 'note' | 'kbDoc'
  id: string
  kbId?: string
  title: string
}): Promise<PinnedItem[]> {
  const settings = await getSettings()
  if (settings.pinnedItems.some((p) => p.kind === item.kind && p.id === item.id)) {
    return settings.pinnedItems
  }
  const pinnedItems: PinnedItem[] = [
    ...settings.pinnedItems,
    {
      id: item.id,
      kind: item.kind,
      kbId: item.kbId,
      title: item.title,
      pinnedAt: new Date().toISOString()
    }
  ]
  await saveSettings({ ...settings, pinnedItems })
  return pinnedItems
}

export async function unpinItem(kind: 'note' | 'kbDoc', id: string): Promise<PinnedItem[]> {
  const settings = await getSettings()
  const pinnedItems = settings.pinnedItems.filter((p) => !(p.kind === kind && p.id === id))
  await saveSettings({ ...settings, pinnedItems })
  return pinnedItems
}

// REQ-108 命令面板最近使用历史（写入 settings.commandHistory）
export async function recordCommandUse(commandId: string): Promise<string[]> {
  const settings = await getSettings()
  const history = [commandId, ...(settings.commandHistory ?? []).filter((c) => c !== commandId)].slice(0, 8)
  await saveSettings({ ...settings, commandHistory: history })
  return history
}

// #endregion

// #region REQ-118 Markdown Lint（基于 markdownlint 标准规则）

export async function lintMarkdown(content: string): Promise<LintIssue[]> {
  // 动态加载避免影响不支持该依赖的环境
  const mod = await import('markdownlint')
  // markdownlint 同步 API 在主进程（Node）可直接调用
  const results = (mod as unknown as { lint: (opts: unknown) => LintRawResult[] }).lint({
    strings: { doc: content },
    config: {
      default: true,
      'no-duplicate-heading': { siblings_only: true },
      'line-length': false, // 不强制行宽
      'no-inline-html': false, // 允许 HTML（如下划线 <u>）
      'no-bare-urls': false
    }
  })
  return results.map((r) => ({
    line: r.lineNumber,
    column: r.errorRange ? r.errorRange[0] : 1,
    rule: r.ruleNames?.join('/') ?? '',
    message: r.ruleDescription ?? r.errorDetail ?? ''
  }))
}

interface LintRawResult {
  lineNumber: number
  errorRange?: [number, number]
  ruleNames?: string[]
  ruleDescription?: string
  errorDetail?: string
}

// #endregion

export { generateSummary, stripMarkdownTitle }

// #region REQ-201 收藏夹（持久化到 settings.json 的 favorites 字段）

export async function listFavorites(): Promise<FavoriteItem[]> {
  const settings = await getSettings()
  return (settings.favorites ?? [])
    .slice()
    .sort((a, b) => new Date(b.favoritedAt).getTime() - new Date(a.favoritedAt).getTime())
}

export async function addFavorite(item: {
  kind: 'note' | 'kbDoc'
  id: string
  kbId?: string
  title: string
}): Promise<FavoriteItem[]> {
  const settings = await getSettings()
  const favorites = settings.favorites ?? []
  if (favorites.some((f) => f.kind === item.kind && f.id === item.id)) {
    return favorites
  }
  const entry: FavoriteItem = {
    id: item.id,
    kind: item.kind,
    kbId: item.kbId,
    title: item.title,
    favoritedAt: new Date().toISOString()
  }
  const next = [entry, ...favorites]
  await saveSettings({ ...settings, favorites: next })
  return next
}

export async function removeFavorite(kind: 'note' | 'kbDoc', id: string): Promise<FavoriteItem[]> {
  const settings = await getSettings()
  const next = (settings.favorites ?? []).filter((f) => !(f.kind === kind && f.id === id))
  await saveSettings({ ...settings, favorites: next })
  return next
}

export async function isFavorite(kind: 'note' | 'kbDoc', id: string): Promise<boolean> {
  const settings = await getSettings()
  return (settings.favorites ?? []).some((f) => f.kind === kind && f.id === id)
}

// #endregion

// #region REQ-202 @提及与反链

// 提及语法：[[type:id|标题]]（type ∈ note / kbDoc）。
// 解析一段 Markdown 文本中出现的全部提及。
export function parseMentions(text: string): DocMention[] {
  if (!text) return []
  const re = /\[\[(note|kbDoc):([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g
  const out: DocMention[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: m[1] as 'note' | 'kbDoc', id: m[2], title: m[3] })
  }
  return out
}

// 提取一段文本中出现的全部提及原始片段（用于反链 snippet 展示）。
function extractMentionSnippets(text: string): { mention: DocMention; snippet: string }[] {
  if (!text) return []
  const re = /\[\[(note|kbDoc):([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]\]/g
  const out: { mention: DocMention; snippet: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({
      mention: { kind: m[1] as 'note' | 'kbDoc', id: m[2], title: m[3] },
      snippet: m[0]
    })
  }
  return out
}

// 反链：扫描全部 Note / KB Doc 内容，找出引用了目标 (kind,id) 的文档。
export async function listBacklinks(kind: 'note' | 'kbDoc', id: string): Promise<Backlink[]> {
  const target = `${kind}:${id}`
  const results: Backlink[] = []

  // Notes
  try {
    const files = await fs.readdir(getNotesDir())
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'groups.json') continue
      try {
        const note = JSON.parse(await fs.readFile(path.join(getNotesDir(), file), 'utf-8')) as Note
        const hits = extractMentionSnippets(note.content ?? '').filter(
          (h) => `${h.mention.kind}:${h.mention.id}` === target
        )
        if (hits.length) {
          results.push({
            kind: 'note',
            id: note.id,
            title: note.title || '无标题',
            snippet: hits[0].snippet,
            updatedAt: note.updatedAt
          })
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // KB Docs
  try {
    const kbs = await readKbMeta()
    for (const kb of kbs) {
      const docs = await readKbDocsMeta(kb.id)
      for (const doc of docs) {
        let content = ''
        try {
          content = await fs.readFile(getKbDocContentPath(kb.id, doc.id), 'utf-8')
        } catch {
          continue
        }
        const hits = extractMentionSnippets(content).filter(
          (h) => `${h.mention.kind}:${h.mention.id}` === target
        )
        if (hits.length) {
          results.push({
            kind: 'kbDoc',
            id: doc.id,
            kbId: kb.id,
            title: doc.name || '未命名文档',
            snippet: hits[0].snippet,
            updatedAt: doc.updatedAt
          })
        }
      }
    }
  } catch {
    // ignore
  }

  return results.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
}

// #endregion

// #region REQ-203 段落评论与文档反馈

const COMMENTS_SUFFIX = '.comments.json'

function getCommentsPath(kbId: string, docId: string): string {
  return path.join(getKbDir(kbId), `${docId}${COMMENTS_SUFFIX}`)
}

async function readComments(kbId: string, docId: string): Promise<KbDocComment[]> {
  try {
    const raw = await fs.readFile(getCommentsPath(kbId, docId), 'utf-8')
    return JSON.parse(raw) as KbDocComment[]
  } catch {
    return []
  }
}

async function writeComments(kbId: string, docId: string, comments: KbDocComment[]): Promise<void> {
  await fs.mkdir(getKbDir(kbId), { recursive: true })
  await fs.writeFile(getCommentsPath(kbId, docId), JSON.stringify(comments, null, 2), 'utf-8')
}

export async function listComments(kbId: string, docId: string): Promise<KbDocComment[]> {
  const comments = await readComments(kbId, docId)
  return comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

export async function createComment(
  kbId: string,
  docId: string,
  paragraphId: string,
  content: string
): Promise<KbDocComment> {
  const text = content.trim()
  if (!text) throw new Error('评论内容不能为空')
  const comments = await readComments(kbId, docId)
  const now = new Date().toISOString()
  const comment: KbDocComment = {
    id: uuidv4(),
    kbId,
    docId,
    paragraphId,
    content: text,
    createdAt: now,
    updatedAt: now
  }
  comments.push(comment)
  await writeComments(kbId, docId, comments)
  return comment
}

export async function updateComment(comment: KbDocComment): Promise<KbDocComment> {
  const comments = await readComments(comment.kbId, comment.docId)
  const index = comments.findIndex((c) => c.id === comment.id)
  if (index === -1) throw new Error(`Comment not found: ${comment.id}`)
  const now = new Date().toISOString()
  const updated: KbDocComment = {
    ...comments[index],
    content: comment.content.trim(),
    updatedAt: now
  }
  comments[index] = updated
  await writeComments(comment.kbId, comment.docId, comments)
  return updated
}

export async function deleteComment(kbId: string, docId: string, id: string): Promise<boolean> {
  const comments = await readComments(kbId, docId)
  const filtered = comments.filter((c) => c.id !== id)
  if (filtered.length === comments.length) return false
  await writeComments(kbId, docId, filtered)
  return true
}

export async function addCommentReply(
  kbId: string,
  docId: string,
  commentId: string,
  content: string
): Promise<KbDocComment | null> {
  const text = content.trim()
  if (!text) throw new Error('回复内容不能为空')
  const comments = await readComments(kbId, docId)
  const index = comments.findIndex((c) => c.id === commentId)
  if (index === -1) return null
  const now = new Date().toISOString()
  const reply: CommentReply = { id: uuidv4(), content: text, createdAt: now, updatedAt: now }
  const replies = [...(comments[index].replies ?? []), reply]
  comments[index] = { ...comments[index], replies, updatedAt: now }
  await writeComments(kbId, docId, comments)
  return comments[index]
}

export async function deleteCommentReply(
  kbId: string,
  docId: string,
  commentId: string,
  replyId: string
): Promise<KbDocComment | null> {
  const comments = await readComments(kbId, docId)
  const index = comments.findIndex((c) => c.id === commentId)
  if (index === -1) return null
  const replies = (comments[index].replies ?? []).filter((r) => r.id !== replyId)
  comments[index] = { ...comments[index], replies, updatedAt: new Date().toISOString() }
  await writeComments(kbId, docId, comments)
  return comments[index]
}

// 编辑一条回复（页面评论的「回答」）
export async function updateCommentReply(
  kbId: string,
  docId: string,
  commentId: string,
  replyId: string,
  content: string
): Promise<KbDocComment | null> {
  const text = content.trim()
  if (!text) throw new Error('回复内容不能为空')
  const comments = await readComments(kbId, docId)
  const index = comments.findIndex((c) => c.id === commentId)
  if (index === -1) return null
  const replies = (comments[index].replies ?? []).map((r) =>
    r.id === replyId ? { ...r, content: text, updatedAt: new Date().toISOString() } : r
  )
  comments[index] = { ...comments[index], replies, updatedAt: new Date().toISOString() }
  await writeComments(kbId, docId, comments)
  return comments[index]
}

// 删除文档时清理评论文件（整文件删除）
async function deleteCommentsFile(kbId: string, docId: string): Promise<boolean> {
  try {
    await fs.unlink(getCommentsPath(kbId, docId))
    return true
  } catch {
    return false
  }
}

// #endregion

// #region REQ-204 搜索历史

export async function recordSearchHistory(keyword: string): Promise<SearchHistoryItem[]> {
  const k = keyword.trim()
  if (!k) return []
  const settings = await getSettings()
  const now = new Date().toISOString()
  const filtered = (settings.searchHistory ?? []).filter(
    (h) => h.keyword.toLowerCase() !== k.toLowerCase()
  )
  const next = [{ keyword: k, searchedAt: now }, ...filtered].slice(0, 10)
  await saveSettings({ ...settings, searchHistory: next })
  return next
}

export async function clearSearchHistory(): Promise<boolean> {
  const settings = await getSettings()
  await saveSettings({ ...settings, searchHistory: [] })
  return true
}

// #endregion


// #region REQ-208 应用锁屏（PBKDF2 哈希存储密码）

const APP_LOCK_ITERATIONS = 100000
const APP_LOCK_KEYLEN = 64
const APP_LOCK_DIGEST = 'sha512'

function hashPassword(password: string, salt: string, iterations: number): string {
  return crypto
    .pbkdf2Sync(password, salt, iterations, APP_LOCK_KEYLEN, APP_LOCK_DIGEST)
    .toString('hex')
}

// 设置/更新启动密码。返回是否成功。
export async function setAppLock(password: string): Promise<boolean> {
  const pwd = password.trim()
  if (!pwd) throw new Error('密码不能为空')
  const settings = await getSettings()
  const salt = crypto.randomBytes(16).toString('hex')
  const passwordHash = hashPassword(pwd, salt, APP_LOCK_ITERATIONS)
  const cfg: AppLockConfig = {
    enabled: true,
    passwordHash,
    salt,
    algorithm: 'pbkdf2',
    iterations: APP_LOCK_ITERATIONS
  }
  await saveSettings({ ...settings, appLock: cfg })
  return true
}

// 校验密码是否正确（不返回哈希，仅布尔结果）。
export async function verifyAppLock(password: string): Promise<boolean> {
  const settings = await getSettings()
  const cfg = settings.appLock
  if (!cfg || !cfg.enabled) return true
  const iterations = cfg.iterations ?? APP_LOCK_ITERATIONS
  const hash = hashPassword(password, cfg.salt, iterations)
  // 定长时间比较，避免计时攻击
  if (hash.length !== cfg.passwordHash.length) return false
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(cfg.passwordHash, 'hex'))
}

// 关闭启动密码（需先验证当前密码）。
export async function clearAppLock(password: string): Promise<boolean> {
  const ok = await verifyAppLock(password)
  if (!ok) return false
  const settings = await getSettings()
  await saveSettings({ ...settings, appLock: null })
  return true
}

// #endregion
