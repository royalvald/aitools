// REQ-120：以本地文件夹作为外部知识库挂载，读写双向同步。
//
// 模型：
// - 外部知识库 = KnowledgeBase{source:'external', externalPath, externalReadOnly}
// - 其文档元数据/层级（按磁盘文件树扫描生成）缓存到 {userData}/external-kbs/{hash}/meta.json
// - 每篇文档的 id 为其相对路径的稳定哈希，content 实时从磁盘 .md 读取
// - 非只读时，saveKbDoc 直接写回原 .md 文件（写前比对 mtime 避免覆盖外部改动）
// - 扩展数据（批注/白板/历史）存到 {userData}/external-kbs/{hash}/extensions/{docId}.*
//
// 注意：外部知识库的 KB id 仍走标准 kb-meta.json，仅 source/externalPath 字段区分。

import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'fs/promises'
import { existsSync, watch } from 'fs'
import path from 'path'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import type {
  KnowledgeBase,
  KnowledgeBaseDoc,
  KnowledgeBaseDocSummary,
  KnowledgeBaseSummary
} from '../shared/types'

export function getExternalKbsDir(): string {
  return path.join(app.getPath('userData'), 'external-kbs')
}

function hashPath(folderPath: string): string {
  return crypto.createHash('sha1').update(folderPath).digest('hex').slice(0, 16)
}

function getExternalMetaPath(folderPath: string): string {
  return path.join(getExternalKbsDir(), hashPath(folderPath), 'meta.json')
}

function getExtensionsDir(folderPath: string, docId: string): string {
  return path.join(getExternalKbsDir(), hashPath(folderPath), 'extensions', docId)
}

async function ensureExternalKbsDir(): Promise<void> {
  await fs.mkdir(getExternalKbsDir(), { recursive: true })
}

/** 文档相对路径 → 稳定 id（去除扩展名）。 */
function relPathToId(relPath: string): string {
  const noExt = relPath.replace(/\.md$/i, '')
  return crypto.createHash('sha1').update(noExt.replace(/\\/g, '/')).digest('hex').slice(0, 16)
}

interface ExternalScanResult {
  docs: Array<{
    id: string
    name: string
    relPath: string
    parentId: string | null
    mtime: string
    order: number
  }>
}

/** 递归扫描文件夹下的 .md 文件，返回带层级的文档列表。 */
async function scanFolder(rootPath: string): Promise<ExternalScanResult> {
  const docs: ExternalScanResult['docs'] = []
  const dirToId = new Map<string, string>()
  // 根目录的 id 用作顶层文档的 parentId
  dirToId.set('', '')

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    // 排除常见噪音目录
    const visible = entries.filter((e) => !e.name.startsWith('.'))
    let order = 0
    for (const entry of visible) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const id = relPathToId(rel)
        const parentRel = relDir ? relDir.replace(/\\/g, '/') : ''
        const parentId = parentRel ? relPathToId(parentRel) : null
        let mtime = new Date().toISOString()
        try {
          const st = await fs.stat(abs)
          mtime = st.mtime.toISOString()
        } catch {
          // ignore
        }
        docs.push({
          id,
          name: entry.name.replace(/\.md$/i, ''),
          relPath: rel.replace(/\\/g, '/'),
          parentId,
          mtime,
          order: order++
        })
      }
    }
  }

  await walk(rootPath, '')
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { docs }
}

async function writeExternalMeta(folderPath: string, data: ExternalScanResult): Promise<void> {
  await ensureExternalKbsDir()
  const file = getExternalMetaPath(folderPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
}

async function readExternalMeta(folderPath: string): Promise<ExternalScanResult | null> {
  try {
    const raw = await fs.readFile(getExternalMetaPath(folderPath), 'utf-8')
    return JSON.parse(raw) as ExternalScanResult
  } catch {
    return null
  }
}

export interface ExternalKbMountResult {
  kb: KnowledgeBase
  docs: ExternalScanResult
}

/** 挂载一个本地文件夹为外部知识库（注册到 kb-meta 并扫描生成文档树缓存）。 */
export async function mountExternalKb(
  folderPath: string,
  readOnly: boolean
): Promise<KnowledgeBaseSummary> {
  // 通过 store 模块注册 kb 元数据（延迟引入避免循环依赖）
  const { createKnowledgeBase, getKnowledgeBase, updateKnowledgeBase, listKnowledgeBases } =
    await import('./store')
  // 检查是否已挂载同一路径（依次取详情比对 externalPath）
  const all = await listKnowledgeBases()
  let existingSummary: KnowledgeBaseSummary | null = null
  for (const k of all) {
    const detail = await getKnowledgeBase(k.id)
    if (detail && detail.externalPath === folderPath) {
      existingSummary = k
      break
    }
  }
  if (existingSummary) {
    await refreshExternalKb(existingSummary.id)
    return existingSummary
  }

  const folderName = path.basename(folderPath) || '外部知识库'
  const kb = await createKnowledgeBase(folderName, '本地文件夹')
  const updated: KnowledgeBase = {
    ...kb,
    source: 'external',
    externalPath: folderPath,
    externalReadOnly: readOnly
  }
  await updateKnowledgeBase(updated)
  await refreshExternalKb(kb.id)
  return {
    id: kb.id,
    name: kb.name,
    category: kb.category,
    updatedAt: kb.updatedAt,
    source: 'external'
  }
}

/** 判断某知识库是否为外部挂载。 */
export async function isExternalKb(kbId: string): Promise<KnowledgeBase | null> {
  const { getKnowledgeBase } = await import('./store')
  const kb = await getKnowledgeBase(kbId)
  if (!kb || kb.source !== 'external' || !kb.externalPath) return null
  return kb
}

/** 重新扫描外部知识库文件夹并刷新文档元数据缓存。 */
export async function refreshExternalKb(kbId: string): Promise<boolean> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return false
  if (!existsSync(kb.externalPath)) return false
  const scan = await scanFolder(kb.externalPath)
  await writeExternalMeta(kb.externalPath, scan)
  return true
}

/** 列出外部知识库的文档（基于扫描缓存）。 */
export async function listExternalKbDocs(kbId: string): Promise<KnowledgeBaseDocSummary[]> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return []
  const scan = await readExternalMeta(kb.externalPath)
  if (!scan) return []
  const now = new Date().toISOString()
  return scan.docs.map((d) => ({
    id: d.id,
    kbId,
    name: d.name || '未命名文档',
    createdAt: now,
    updatedAt: d.mtime,
    parentId: d.parentId,
    order: d.order,
    tags: []
  }))
}

/** 读取外部知识库单篇文档内容（实时从磁盘读取）。 */
export async function getExternalKbDoc(
  kbId: string,
  docId: string
): Promise<KnowledgeBaseDoc | null> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return null
  const scan = await readExternalMeta(kb.externalPath)
  if (!scan) return null
  const meta = scan.docs.find((d) => d.id === docId)
  if (!meta) return null
  const abs = path.join(kb.externalPath, meta.relPath)
  let content = ''
  let mtime = meta.mtime
  try {
    content = await fs.readFile(abs, 'utf-8')
    const st = await fs.stat(abs)
    mtime = st.mtime.toISOString()
  } catch {
    // 文件可能已被删除
    return null
  }
  return {
    id: meta.id,
    kbId,
    name: meta.name,
    content,
    createdAt: meta.mtime,
    updatedAt: mtime,
    linkedNoteIds: [],
    parentId: meta.parentId,
    order: meta.order,
    tags: []
  }
}

/** 写回外部知识库文档（非只读时）。返回写回后的文档，或拒绝（只读/冲突）时返回 null。 */
export async function saveExternalKbDoc(doc: KnowledgeBaseDoc): Promise<KnowledgeBaseDoc | null> {
  const kb = await isExternalKb(doc.kbId)
  if (!kb || !kb.externalPath) return null
  if (kb.externalReadOnly) return null
  const scan = await readExternalMeta(kb.externalPath)
  if (!scan) return null
  const meta = scan.docs.find((d) => d.id === doc.id)
  if (!meta) return null
  const abs = path.join(kb.externalPath, meta.relPath)
  // 写前 mtime 校验：若磁盘文件已被外部改动（mtime 比缓存新），拒绝覆盖，避免丢数据。
  try {
    const st = await fs.stat(abs)
    if (st.mtime.toISOString() > meta.mtime) {
      // 外部已修改，拒绝覆盖；调用方可提示用户刷新
      return null
    }
  } catch {
    // 文件不存在则继续创建
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, doc.content, 'utf-8')
  // 更新缓存 mtime
  const st2 = await fs.stat(abs)
  meta.mtime = st2.mtime.toISOString()
  await writeExternalMeta(kb.externalPath, scan)
  return { ...doc, updatedAt: st2.mtime.toISOString() }
}

/** 在外部知识库中新建一篇 .md 文件（顶层或某子目录下）。 */
export async function createExternalKbDoc(
  kbId: string,
  name: string,
  parentId: string | null
): Promise<KnowledgeBaseDoc | null> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return null
  if (kb.externalReadOnly) return null
  const scan = await readExternalMeta(kb.externalPath)
  if (!scan) return null
  // 找到父目录的 relPath
  let parentRel = ''
  if (parentId) {
    const parent = scan.docs.find((d) => d.id === parentId)
    if (parent) {
      // 父是文件，其所在目录作为新文件目录
      parentRel = path.dirname(parent.relPath)
    }
  }
  const safeName = (name.trim() || '未命名文档').replace(/[\\/:*?"<>|]/g, '_')
  // 避免重名：若存在则追加序号
  let relPath = parentRel ? path.join(parentRel, `${safeName}.md`) : `${safeName}.md`
  relPath = relPath.replace(/\\/g, '/')
  let candidate = relPath
  let i = 2
  const exists = (rp: string) => scan.docs.some((d) => d.relPath === rp)
  while (exists(candidate)) {
    candidate = parentRel
      ? path.join(parentRel, `${safeName} (${i}).md`).replace(/\\/g, '/')
      : `${safeName} (${i}).md`
    i++
  }
  relPath = candidate
  const abs = path.join(kb.externalPath, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, '', 'utf-8')
  await refreshExternalKb(kbId)
  const id = relPathToId(relPath)
  return getExternalKbDoc(kbId, id)
}

/** 删除外部知识库的一篇 .md 文件。 */
export async function deleteExternalKbDoc(kbId: string, docId: string): Promise<boolean> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return false
  if (kb.externalReadOnly) return false
  const scan = await readExternalMeta(kb.externalPath)
  if (!scan) return false
  const meta = scan.docs.find((d) => d.id === docId)
  if (!meta) return false
  const abs = path.join(kb.externalPath, meta.relPath)
  try {
    await fs.unlink(abs)
  } catch {
    return false
  }
  await refreshExternalKb(kbId)
  return true
}

/** 外部知识库扩展数据（批注/白板/历史）目录。 */
export async function getExternalExtensionPath(
  kbId: string,
  docId: string,
  file: string
): Promise<string | null> {
  const kb = await isExternalKb(kbId)
  if (!kb || !kb.externalPath) return null
  const dir = getExtensionsDir(kb.externalPath, docId)
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, file)
}

/** 生成临时 uuid（供外部知识库内部使用，避免引入更多导入）。 */
export function newUuid(): string {
  return uuidv4()
}

// #region 文件夹监听 + 广播（外部文件夹被外部改动时通知渲染进程刷新）

const watchers = new Map<string, { watcher: import('fs').FSWatcher; timer: NodeJS.Timeout }>()

function scheduleRefresh(kbId: string, folderPath: string): void {
  const existing = watchers.get(kbId)
  if (existing) {
    clearTimeout(existing.timer)
    existing.timer = setTimeout(async () => {
      await refreshExternalKb(kbId)
      broadcastExternalKbChanged(kbId)
    }, 600)
    return
  }
  const timer = setTimeout(async () => {
    await refreshExternalKb(kbId)
    broadcastExternalKbChanged(kbId)
  }, 600)
  watchers.set(kbId, { watcher: null as never, timer })
}

/** 启动对外部知识库根文件夹的监听（防抖 600ms）。 */
export function startWatchingExternalKb(kbId: string, folderPath: string): void {
  try {
    const w = watch(folderPath, { recursive: true }, () => scheduleRefresh(kbId, folderPath))
    const existing = watchers.get(kbId)
    if (existing?.watcher) existing.watcher.close()
    watchers.set(kbId, { watcher: w, timer: existing?.timer ?? setTimeout(() => {}, 0) })
    w.on('error', () => {
      // 监听失败（如权限/平台限制）静默忽略，用户仍可手动刷新
    })
  } catch {
    // ignore
  }
}

export function stopWatchingExternalKb(kbId: string): void {
  const entry = watchers.get(kbId)
  if (entry) {
    try {
      entry.watcher?.close?.()
    } catch {
      // ignore
    }
    clearTimeout(entry.timer)
    watchers.delete(kbId)
  }
}

/** 通知所有窗口某外部知识库发生变化（用于刷新文档树）。 */
export function broadcastExternalKbChanged(kbId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('externalKb:changed', kbId)
  }
}

/** 注册一次性渲染订阅桥接。 */
export function registerExternalKbBridge(): void {
  ipcMain.on('externalKb:subscribe', (_e, kbId: string, folderPath: string) => {
    startWatchingExternalKb(kbId, folderPath)
  })
  ipcMain.on('externalKb:unsubscribe', (_e, kbId: string) => {
    stopWatchingExternalKb(kbId)
  })
}

// #endregion
