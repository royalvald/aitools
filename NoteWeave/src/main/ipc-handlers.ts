import { app, ipcMain, clipboard, nativeImage, shell } from 'electron'
import {
  addLink,
  createKbDoc,
  createKnowledgeBase,
  createNote,
  createNoteGroup,
  createTodo,
  deleteKbDoc,
  deleteKnowledgeBase,
  deleteNote,
  deleteNoteGroup,
  deleteTodo,
  deleteWhiteboard,
  getKnowledgeBase,
  getKbDoc,
  getNote,
  getTodo,
  getWhiteboard,
  listAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  addAnnotationReply,
  deleteAnnotationReply,
  listKnowledgeBases,
  listKbDocs,
  listNoteGroups,
  listNotes,
  listTodos,
  removeLink,
  saveKbDoc,
  saveNote,
  saveTodo,
  saveWhiteboard,
  updateKnowledgeBase,
  updateNoteGroup,
  listLinksForDoc,
  listLinksForNote,
  getSettings,
  saveSettings,
  saveImageAsset,
  saveAttachmentAsset,
  listAssets,
  deleteAssetByUrl,
  pruneOrphanAssets,
  listAllAssets,
  assetUrlToAbs,
  findExclusiveAssets,
  search,
  listTrash,
  restoreTrash,
  deleteTrash,
  emptyTrash,
  listHistory,
  getHistory,
  saveHistorySnapshot,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  moveKbDoc,
  reorderKbDocs,
  recordRecentItem,
  pinItem,
  unpinItem,
  recordCommandUse,
  listThemes,
  getTheme,
  saveTheme,
  deleteTheme,
  resolveThemeCss,
  lintMarkdown,
  // REQ-201 收藏夹
  listFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
  // REQ-202 @提及与反链
  listBacklinks,
  // REQ-203 段落评论
  listComments,
  createComment,
  updateComment,
  deleteComment,
  addCommentReply,
  deleteCommentReply,
  updateCommentReply,
  // REQ-204 搜索历史
  recordSearchHistory,
  clearSearchHistory,
  // REQ-208 应用锁屏
  setAppLock,
  verifyAppLock,
  clearAppLock
} from './store'
import {
  isExternalKb,
  refreshExternalKb,
  listExternalKbDocs,
  getExternalKbDoc,
  saveExternalKbDoc,
  createExternalKbDoc,
  deleteExternalKbDoc,
  mountExternalKb,
  broadcastExternalKbChanged
} from './external-kb'
import {
  checkJava,
  checkGraphviz,
  renderGraphviz,
  renderPlantUml
} from './diagram-render'
import { detectPandoc } from './pandoc'
import { exportAllData, importData } from './export-import'
import { importExternalFiles } from './import-external'
import { exportKnowledgeBase } from './kb-export'
import { ocrImageByUrl, ocrBatch } from './ocr'
import {
  createMindmapDoc,
  getMindmapDoc,
  saveMindmapDoc,
  mindmapDocFromMarkdown,
  exportMindmapDoc
} from './mindmap-doc'
import { ollamaListModels, ollamaGenerate } from './ollama'
import { listWbTemplates, saveWbTemplate, deleteWbTemplate } from './wb-templates'
import { exportWhiteboard, exportWhiteboardFramesPdf } from './wb-export'
import { exportDoc } from './doc-export'
import type {
  AppSettings,
  KnowledgeBase,
  KnowledgeBaseDoc,
  KbDocAnnotation,
  Note,
  SearchHitType,
  Todo,
  Whiteboard
} from '../shared/types'

export function registerIpcHandlers(): void {
  // Notes
  ipcMain.handle('notes:list', async () => listNotes())

  ipcMain.handle('notes:get', async (_, id: string) => getNote(id))

  ipcMain.handle('notes:create', async (_, groupId?: string | null) => createNote(groupId))

  ipcMain.handle('notes:save', async (_, note: Note) => saveNote(note))

  ipcMain.handle('notes:delete', async (_, id: string) => deleteNote(id))

  // Note groups (two-level classification)
  ipcMain.handle('noteGroup:list', async () => listNoteGroups())

  ipcMain.handle('noteGroup:create', async (_, name: string, parentId: string | null) =>
    createNoteGroup(name, parentId)
  )

  ipcMain.handle('noteGroup:update', async (_, id: string, name: string) =>
    updateNoteGroup(id, name)
  )

  ipcMain.handle('noteGroup:delete', async (_, id: string) => deleteNoteGroup(id))

  // Knowledge bases
  ipcMain.handle('kb:list', async () => listKnowledgeBases())

  ipcMain.handle('kb:get', async (_, id: string) => getKnowledgeBase(id))

  ipcMain.handle('kb:create', async (_, name: string, category: string) =>
    createKnowledgeBase(name, category)
  )

  ipcMain.handle('kb:update', async (_, kb: KnowledgeBase) => updateKnowledgeBase(kb))

  ipcMain.handle('kb:delete', async (_, id: string) => deleteKnowledgeBase(id))

  // Knowledge base documents（外部知识库走 external-kb 分支）
  ipcMain.handle('kbDoc:list', async (_, kbId: string) => {
    if (await isExternalKb(kbId)) return listExternalKbDocs(kbId)
    return listKbDocs(kbId)
  })

  ipcMain.handle('kbDoc:get', async (_, kbId: string, docId: string) => {
    if (await isExternalKb(kbId)) return getExternalKbDoc(kbId, docId)
    return getKbDoc(kbId, docId)
  })

  ipcMain.handle('kbDoc:create', async (_, kbId: string, name: string, parentId?: string | null) => {
    if (await isExternalKb(kbId)) return createExternalKbDoc(kbId, name, parentId ?? null)
    return createKbDoc(kbId, name)
  })

  ipcMain.handle('kbDoc:save', async (_, doc: KnowledgeBaseDoc) => {
    if (await isExternalKb(doc.kbId)) return saveExternalKbDoc(doc)
    return saveKbDoc(doc)
  })

  ipcMain.handle('kbDoc:delete', async (_, kbId: string, docId: string) => {
    if (await isExternalKb(kbId)) return deleteExternalKbDoc(kbId, docId)
    return deleteKbDoc(kbId, docId)
  })

  // Knowledge base document annotations
  ipcMain.handle('annotation:list', async (_, kbId: string, docId: string) => listAnnotations(kbId, docId))

  ipcMain.handle(
    'annotation:create',
    async (_, kbId: string, docId: string, text: string, startOffset: number, endOffset: number, content: string) =>
      createAnnotation(kbId, docId, text, startOffset, endOffset, content)
  )

  ipcMain.handle('annotation:update', async (_, annotation: KbDocAnnotation) => updateAnnotation(annotation))

  ipcMain.handle('annotation:delete', async (_, kbId: string, docId: string, id: string) =>
    deleteAnnotation(kbId, docId, id)
  )

  // Links between notes and KB docs
  ipcMain.handle('link:add', async (_, noteId: string, kbDocId: string) => addLink(noteId, kbDocId))

  ipcMain.handle('link:remove', async (_, noteId: string, kbDocId: string) => removeLink(noteId, kbDocId))

  ipcMain.handle('link:listForNote', async (_, noteId: string) => listLinksForNote(noteId))

  ipcMain.handle('link:listForDoc', async (_, kbDocId: string) => listLinksForDoc(kbDocId))

  // Import / Export
  ipcMain.handle('data:export', async () => exportAllData())

  ipcMain.handle('data:import', async () => importData())

  // REQ-209 批量导入外部格式
  ipcMain.handle('data:importExternal', async (_, kbId: string | null) =>
    importExternalFiles(kbId)
  )

  // UE-18 设置·数据分区：数据目录展示与「打开目录」
  ipcMain.handle('data:getDir', () => app.getPath('userData'))
  ipcMain.handle('data:openDir', async () => {
    try {
      const result = await shell.openPath(app.getPath('userData'))
      return result === ''
    } catch {
      return false
    }
  })

  // REQ-210 批量导出整个知识库
  ipcMain.handle('kb:export', async (_, kbId: string, options) =>
    exportKnowledgeBase(kbId, options)
  )

  // Whiteboard
  ipcMain.handle('whiteboard:get', async (_, kbId: string, docId: string) => getWhiteboard(kbId, docId))

  ipcMain.handle('whiteboard:save', async (_, whiteboard: Whiteboard) => saveWhiteboard(whiteboard))

  ipcMain.handle('whiteboard:delete', async (_, kbId: string, docId: string) => deleteWhiteboard(kbId, docId))

  // Todos
  ipcMain.handle('todo:list', async () => listTodos())

  ipcMain.handle('todo:get', async (_, id: string) => getTodo(id))

  ipcMain.handle(
    'todo:create',
    async (_, title: string, detail: string, targetType: 'note' | 'kbDoc', targetId: string, kbId?: string) =>
      createTodo(title, detail, targetType, targetId, kbId)
  )

  ipcMain.handle('todo:save', async (_, todo: Todo) => saveTodo(todo))

  ipcMain.handle('todo:delete', async (_, id: string) => deleteTodo(id))

  // Settings
  ipcMain.handle('settings:get', async () => getSettings())

  ipcMain.handle('settings:save', async (_, settings: AppSettings) => saveSettings(settings))

  // REQ-004/016 资源（图片/附件）
  ipcMain.handle('asset:readClipboardImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const png = img.toPNG()
    // PNG 为通用安全格式；剪贴板原始格式不确定，统一按 png
    return { buffer: Array.from(png), ext: 'png' }
  })

  ipcMain.handle(
    'asset:saveImage',
    async (_, scope: 'note' | 'kb', ownerId: string, buffer: number[], ext: string) =>
      saveImageAsset(scope, ownerId, Buffer.from(buffer), ext)
  )

  ipcMain.handle(
    'asset:saveAttachment',
    async (_, scope: 'note' | 'kb', ownerId: string, buffer: number[], name: string) =>
      saveAttachmentAsset(scope, ownerId, Buffer.from(buffer), name)
  )

  ipcMain.handle('asset:delete', async (_, url: string) => deleteAssetByUrl(url))

  ipcMain.handle('asset:list', async (_, scope: 'note' | 'kb', ownerId: string) =>
    listAssets(scope, ownerId)
  )

  ipcMain.handle('asset:prune', async () => pruneOrphanAssets())

  ipcMain.handle('asset:listAll', async () => listAllAssets())

  // REQ-004 图片右键菜单能力：复制图片到剪贴板 / 在文件夹中显示 / 用系统查看器打开。
  ipcMain.handle('asset:writeClipboardImage', async (_, url: string) => {
    try {
      const abs = assetUrlToAbs(url)
      const buf = await import('fs/promises').then((fsp) => fsp.readFile(abs))
      const ext = abs.toLowerCase().split('.').pop() ?? ''
      if (ext === 'svg') {
        // nativeImage 不支持 SVG，回退为写入文件路径文本。
        clipboard.writeText(abs)
        return true
      }
      const img = nativeImage.createFromBuffer(buf)
      if (img.isEmpty()) return false
      clipboard.writeImage(img)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('asset:showInFolder', async (_, url: string) => {
    try {
      shell.showItemInFolder(assetUrlToAbs(url))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('asset:openImage', async (_, url: string) => {
    try {
      const result = await shell.openPath(assetUrlToAbs(url))
      return result === ''
    } catch {
      return false
    }
  })

  // REQ-004：查找仅被指定文档/笔记引用的资源 URL（删除时提示清理）。
  ipcMain.handle(
    'asset:findExclusive',
    async (
      _,
      target:
        | { kind: 'note'; noteId: string; content: string }
        | { kind: 'kbDoc'; kbId: string; docId: string; content: string }
    ) => findExclusiveAssets(target)
  )

  // REQ-005 全文搜索
  ipcMain.handle('search:query', async (_, keyword: string, options?: {
    filters?: SearchHitType[]
    dateFrom?: string
    dateTo?: string
    sortBy?: 'updatedAt' | 'relevance'
  }) => search(keyword, options ?? {}))

  // REQ-008 / REQ-112 单文档导出（含扩展格式）
  ipcMain.handle(
    'export:doc',
    async (
      _,
      target: { kind: 'note'; noteId: string } | { kind: 'kbDoc'; kbId: string; docId: string },
      format:
        | 'pdf'
        | 'html'
        | 'word'
        | 'epub'
        | 'latex'
        | 'rtf'
        | 'txt'
        | 'opml'
        | 'markdown',
      options?: { includeAnnotations?: boolean; themeName?: string; usePandoc?: boolean }
    ) => exportDoc(target, format, options)
  )

  // REQ-013 回收站
  ipcMain.handle('trash:list', async () => listTrash())
  ipcMain.handle('trash:restore', async (_, id: string) => restoreTrash(id))
  ipcMain.handle('trash:delete', async (_, id: string) => deleteTrash(id))
  ipcMain.handle('trash:empty', async () => emptyTrash())

  // REQ-014 版本历史
  ipcMain.handle('history:list', async (_, scope: 'note' | 'kbDoc', refId: string) =>
    listHistory(scope, refId)
  )
  ipcMain.handle('history:get', async (_, id: string) => getHistory(id))
  ipcMain.handle(
    'history:save',
    async (_, scope: 'note' | 'kbDoc', refId: string, content: string) =>
      saveHistorySnapshot(scope, refId, content)
  )

  // REQ-011 文档模板
  ipcMain.handle('template:list', async () => listTemplates())
  ipcMain.handle('template:save', async (_, name: string, content: string) =>
    saveTemplate(name, content)
  )
  ipcMain.handle('template:delete', async (_, id: string) => deleteTemplate(id))

  // REQ-006 文档层级
  ipcMain.handle(
    'kbDoc:move',
    async (_, kbId: string, docId: string, parentId: string | null, order: number) =>
      moveKbDoc(kbId, docId, parentId, order)
  )
  ipcMain.handle('kbDoc:reorder', async (_, kbId: string, orderedIds: string[]) =>
    reorderKbDocs(kbId, orderedIds)
  )

  // REQ-015 批注回复
  ipcMain.handle(
    'annotation:addReply',
    async (_, annotation: KbDocAnnotation, content: string) =>
      addAnnotationReply(annotation.kbId, annotation.docId, annotation.id, content)
  )
  ipcMain.handle(
    'annotation:deleteReply',
    async (_, annotation: KbDocAnnotation, replyId: string) =>
      deleteAnnotationReply(annotation.kbId, annotation.docId, annotation.id, replyId)
  )

  // REQ-110 最近 / 固定文件
  ipcMain.handle('recent:record', async (_, item) => recordRecentItem(item))
  ipcMain.handle('recent:pin', async (_, item) => pinItem(item))
  ipcMain.handle('recent:unpin', async (_, kind, id) => unpinItem(kind, id))
  ipcMain.handle('command:recordUse', async (_, commandId: string) => recordCommandUse(commandId))

  // REQ-111 自定义主题
  ipcMain.handle('theme:list', async () => listThemes())
  ipcMain.handle('theme:get', async (_, id: string) => getTheme(id))
  ipcMain.handle('theme:save', async (_, theme) => saveTheme(theme))
  ipcMain.handle('theme:delete', async (_, id: string) => deleteTheme(id))
  ipcMain.handle('theme:resolveCss', async (_, name: string) => resolveThemeCss(name))

  // REQ-115 图表本地渲染
  ipcMain.handle('diagram:checkJava', async () => checkJava())
  ipcMain.handle('diagram:checkGraphviz', async () => checkGraphviz())
  ipcMain.handle('diagram:plantuml', async (_, source: string) => renderPlantUml(source))
  ipcMain.handle('diagram:graphviz', async (_, source: string) => renderGraphviz(source))

  // REQ-118 Markdown Lint
  ipcMain.handle('lint:check', async (_, content: string) => lintMarkdown(content))

  // REQ-119 Pandoc 检测
  ipcMain.handle('pandoc:detect', async () => detectPandoc())

  // REQ-120 外部文件夹知识库
  ipcMain.handle('externalKb:mount', async (_, folderPath: string, readOnly: boolean) =>
    mountExternalKb(folderPath, readOnly)
  )
  ipcMain.handle('externalKb:refresh', async (_, kbId: string) => {
    const ok = await refreshExternalKb(kbId)
    if (ok) broadcastExternalKbChanged(kbId)
    return ok
  })

  // REQ-201 收藏夹
  ipcMain.handle('favorite:list', async () => listFavorites())
  ipcMain.handle('favorite:add', async (_, item) => addFavorite(item))
  ipcMain.handle('favorite:remove', async (_, kind, id) => removeFavorite(kind, id))
  ipcMain.handle('favorite:is', async (_, kind, id) => isFavorite(kind, id))

  // REQ-202 @提及与反链
  ipcMain.handle('backlink:list', async (_, kind: 'note' | 'kbDoc', id: string) =>
    listBacklinks(kind, id)
  )

  // REQ-203 段落评论与文档反馈
  ipcMain.handle('comment:list', async (_, kbId: string, docId: string) =>
    listComments(kbId, docId)
  )
  ipcMain.handle(
    'comment:create',
    async (_, kbId: string, docId: string, paragraphId: string, content: string) =>
      createComment(kbId, docId, paragraphId, content)
  )
  ipcMain.handle('comment:update', async (_, comment) => updateComment(comment))
  ipcMain.handle('comment:delete', async (_, kbId: string, docId: string, id: string) =>
    deleteComment(kbId, docId, id)
  )
  ipcMain.handle(
    'comment:addReply',
    async (_, comment, content: string) => addCommentReply(comment.kbId, comment.docId, comment.id, content)
  )
  ipcMain.handle(
    'comment:deleteReply',
    async (_, comment, replyId: string) => deleteCommentReply(comment.kbId, comment.docId, comment.id, replyId)
  )
  ipcMain.handle(
    'comment:updateReply',
    async (_, comment, replyId: string, content: string) =>
      updateCommentReply(comment.kbId, comment.docId, comment.id, replyId, content)
  )

  // REQ-204 搜索历史
  ipcMain.handle('search:recordHistory', async (_, keyword: string) =>
    recordSearchHistory(keyword)
  )
  ipcMain.handle('search:clearHistory', async () => clearSearchHistory())

  // REQ-208 应用锁屏
  ipcMain.handle('appLock:set', async (_, password: string) => setAppLock(password))
  ipcMain.handle('appLock:verify', async (_, password: string) => verifyAppLock(password))
  ipcMain.handle('appLock:clear', async (_, password: string) => clearAppLock(password))

  // REQ-205 图片 OCR 搜索
  ipcMain.handle('ocr:image', async (_, assetUrl: string, force?: boolean) =>
    ocrImageByUrl(assetUrl, force)
  )
  ipcMain.handle('ocr:batch', async () => ocrBatch())

  // 扩展文档类型（mindmap）
  ipcMain.handle(
    'kbDoc:createWithType',
    async (_, kbId: string, name: string, docType: string) => {
      if (docType === 'mindmap') {
        const r = await createMindmapDoc(kbId, name)
        const { getKbDoc } = await import('./store')
        return getKbDoc(r.kbId, r.docId)
      }
      // 其它类型暂按 markdown 创建（后续批次实现）
      const { createKbDoc, saveKbDoc } = await import('./store')
      const doc = await createKbDoc(kbId, name)
      return saveKbDoc({ ...doc, docType: docType as never, content: '' })
    }
  )

  // REQ-212 思维导图
  ipcMain.handle('mindmap:get', async (_, kbId: string, docId: string) =>
    getMindmapDoc(kbId, docId)
  )
  ipcMain.handle(
    'mindmap:save',
    async (_, kbId: string, docId: string, data) => saveMindmapDoc(kbId, docId, data)
  )
  ipcMain.handle(
    'mindmap:fromMarkdown',
    async (_, kbId: string, docId: string, markdown: string) =>
      mindmapDocFromMarkdown(kbId, docId, markdown)
  )
  ipcMain.handle(
    'mindmap:export',
    async (_, kbId: string, docId: string, format: 'opml' | 'png', pngDataUrl?: string) =>
      exportMindmapDoc(kbId, docId, format, pngDataUrl)
  )

  ipcMain.handle(
    'whiteboard:exportFramesPdf',
    async (_, kbId: string, docId: string, framesSvgs: string[]) =>
      exportWhiteboardFramesPdf(kbId, docId, framesSvgs)
  )

  // REQ-225 白板模板库
  ipcMain.handle('wbTemplate:list', async () => listWbTemplates())
  ipcMain.handle(
    'wbTemplate:save',
    async (_, name: string, elements: unknown[], frames?: unknown[]) =>
      saveWbTemplate(name, elements as never, frames as never)
  )
  ipcMain.handle('wbTemplate:delete', async (_, id: string) => deleteWbTemplate(id))

  // REQ-228 白板导出
  ipcMain.handle(
    'whiteboard:export',
    async (_, whiteboard, format: 'png' | 'svg' | 'markdown', pngDataUrl?: string) =>
      exportWhiteboard(whiteboard as never, format, pngDataUrl)
  )

  // REQ-215 本地 AI（Ollama）
  ipcMain.handle('ollama:check', async (_, url: string) => ollamaListModels(url))
  ipcMain.handle(
    'ollama:generate',
    async (_, model: string, prompt: string, options?: { temperature?: number }) => {
      const s = await getSettings()
      const url = s.ollama?.url ?? 'http://127.0.0.1:11434'
      let useModel = model
      if (!useModel) {
        // 模型为空时用设置中的模型，再为空则取第一个可用
        useModel = s.ollama?.model ?? ''
        if (!useModel) {
          const list = await ollamaListModels(url)
          useModel = list.models?.[0] ?? ''
        }
      }
      if (!useModel) {
        return { ok: false, error: '未指定模型，且无法列出可用模型' }
      }
      return ollamaGenerate(url, useModel, prompt, options)
    }
  )
}
