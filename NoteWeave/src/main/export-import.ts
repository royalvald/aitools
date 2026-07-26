import { app, BrowserWindow, dialog } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import type { ExportResult, ImportResult } from '../shared/types'
import {
  countTodos,
  getAssetsDir,
  getKnowledgeBasesDir,
  getNotesDir,
  getTodosDir,
  getTrashDir,
  getHistoryBaseDir,
  getTemplatesDir,
  getThemesDir,
  getSettingsPath
} from './store'
import { getExternalKbsDir } from './external-kb'
import { getOcrCacheDir } from './ocr'

// 备份文件清单单 v2：在 v1（notes/knowledge-bases/todos/assets）基础上
// 补齐 settings/trash/history/templates/themes/external-kbs/ocr-cache，实现全量备份。
const MANIFEST_VERSION = 2
// 数据结构版本：未来若存储格式变更，启动时可据此做 schema 迁移。当前 = 1。
const DATA_VERSION = 1

/** 数据目录条目：zip 内前缀 + 本地目录 getter + 是否纯缓存（可省略/可重建）。 */
interface DataEntry {
  zipPrefix: string
  getDir: () => string
  /** true 表示该目录为可重建缓存（如 ocr-cache），缺失不影响数据完整性。 */
  optional?: boolean
}

// 全量数据目录注册表（单一事实来源）。备份与还原均遍历此表。
const DATA_ENTRIES: DataEntry[] = [
  { zipPrefix: 'notes', getDir: getNotesDir },
  { zipPrefix: 'knowledge-bases', getDir: getKnowledgeBasesDir },
  { zipPrefix: 'assets', getDir: getAssetsDir },
  { zipPrefix: 'todos', getDir: getTodosDir },
  { zipPrefix: 'history', getDir: getHistoryBaseDir },
  { zipPrefix: 'trash', getDir: getTrashDir },
  { zipPrefix: 'templates', getDir: getTemplatesDir },
  { zipPrefix: 'themes', getDir: getThemesDir },
  { zipPrefix: 'external-kbs', getDir: getExternalKbsDir },
  { zipPrefix: 'ocr-cache', getDir: getOcrCacheDir, optional: true }
]

// settings.json 是单文件，单独处理（不在 DATA_ENTRIES 中）。
const SETTINGS_ZIP_PATH = 'settings.json'

function getDefaultExportFileName(): string {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `notefordetail-export-${date}.zip`
}

function getDefaultBackupFileName(): string {
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `notefordetail-backup-${date}.zip`
}

async function getFocusedWindow(): Promise<BrowserWindow | null> {
  return BrowserWindow.getFocusedWindow()
}

async function addDirToZip(zip: JSZip, dirPath: string, zipPrefix: string): Promise<number> {
  let count = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const zipPath = path.posix.join(zipPrefix, entry.name)
      if (entry.isDirectory()) {
        const subCount = await addDirToZip(zip, fullPath, zipPath)
        count += subCount
      } else {
        const content = await fs.readFile(fullPath)
        zip.file(zipPath, content)
        count++
      }
    }
  } catch {
    // Directory may not exist
  }
  return count
}

async function countNotes(dirPath: string): Promise<number> {
  try {
    const files = await fs.readdir(dirPath)
    // 排除 groups.json（分组定义文件），它不是一条提示任务。
    return files.filter((f) => f.endsWith('.json') && f !== 'groups.json').length
  } catch {
    return 0
  }
}

async function countKnowledgeBasesAndDocs(
  dirPath: string
): Promise<{ kbs: number; docs: number; whiteboards: number; annotations: number }> {
  let kbs = 0
  let docs = 0
  let whiteboards = 0
  let annotations = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        kbs++
        const kbFiles = await fs.readdir(path.join(dirPath, entry.name))
        docs += kbFiles.filter((f) => f.endsWith('.md')).length
        whiteboards += kbFiles.filter((f) => f.endsWith('.whiteboard.json')).length
        annotations += kbFiles.filter((f) => f.endsWith('.annotations.json')).length
      }
    }
  } catch {
    // Directory may not exist
  }
  return { kbs, docs, whiteboards, annotations }
}

/** 递归统计目录下文件数（用于 history/templates/themes/trash 等的计数）。 */
async function countFilesInDir(dirPath: string): Promise<number> {
  let count = 0
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        count += await countFilesInDir(fullPath)
      } else {
        count++
      }
    }
  } catch {
    // Directory may not exist
  }
  return count
}

/** 把所有数据目录 + settings.json 打包进 zip。返回各目录文件计数。 */
async function packAllData(zip: JSZip): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const entry of DATA_ENTRIES) {
    counts[entry.zipPrefix] = await addDirToZip(zip, entry.getDir(), entry.zipPrefix)
  }
  // settings.json 单文件
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf-8')
    zip.file(SETTINGS_ZIP_PATH, raw)
    counts[SETTINGS_ZIP_PATH] = 1
  } catch {
    counts[SETTINGS_ZIP_PATH] = 0
  }
  return counts
}

export async function exportAllData(): Promise<ExportResult> {
  const window = await getFocusedWindow()
  if (!window) {
    return { success: false, filePath: null, error: '没有可用的窗口' }
  }

  const { filePath, canceled } = await dialog.showSaveDialog(window, {
    title: '导出所有数据',
    defaultPath: getDefaultExportFileName(),
    filters: [{ name: 'ZIP 文件', extensions: ['zip'] }]
  })

  if (canceled || !filePath) {
    return { success: false, filePath: null }
  }

  try {
    const zip = new JSZip()
    const fileCounts = await packAllData(zip)

    // 统计汇总数据，写入 manifest
    const noteCount = await countNotes(getNotesDir())
    const { kbs: kbCount, docs: kbDocCount, whiteboards: whiteboardCount, annotations: annotationCount } =
      await countKnowledgeBasesAndDocs(getKnowledgeBasesDir())
    const todoCount = await countTodos()
    const historySnapshots = await countFilesInDir(getHistoryBaseDir())
    const templates = await countFilesInDir(getTemplatesDir())
    const themes = await countFilesInDir(getThemesDir())
    // trash 是单文件 trash.json，用存在性判断
    let trashItems = 0
    try {
      const trashRaw = await fs.readFile(path.join(getTrashDir(), 'trash.json'), 'utf-8')
      const parsed = JSON.parse(trashRaw)
      trashItems = Array.isArray(parsed) ? parsed.length : 0
    } catch {
      trashItems = 0
    }

    const manifest = {
      version: MANIFEST_VERSION,
      dataVersion: DATA_VERSION,
      appVersion: app.getVersion(),
      exportedAt: new Date().toISOString(),
      // 实际打包的条目清单，便于还原时校验与按需提取
      entries: Object.keys(fileCounts),
      fileCounts,
      counts: {
        notes: noteCount,
        knowledgeBases: kbCount,
        kbDocs: kbDocCount,
        whiteboards: whiteboardCount,
        annotations: annotationCount,
        todos: todoCount,
        historySnapshots,
        trashItems,
        templates,
        themes
      }
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2))

    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    await fs.writeFile(filePath, buffer)

    return {
      success: true,
      filePath,
      counts: manifest.counts
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, filePath: null, error: `导出失败：${message}` }
  }
}

/** 全量自动备份（导入前调用）。返回备份文件路径或 null。 */
async function createBackupZip(targetDir: string): Promise<string | null> {
  try {
    const zip = new JSZip()
    await packAllData(zip)
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const backupPath = path.join(targetDir, getDefaultBackupFileName())
    await fs.writeFile(backupPath, buffer)
    return backupPath
  } catch {
    return null
  }
}

interface ManifestInfo {
  version: number
  dataVersion?: number
  entries?: string[]
}

async function readManifest(zip: JSZip): Promise<ManifestInfo | null> {
  const manifestFile = zip.file('manifest.json')
  if (!manifestFile) return null
  try {
    const content = await manifestFile.async('string')
    const manifest = JSON.parse(content)
    if (typeof manifest.version !== 'number') return null
    return {
      version: manifest.version,
      dataVersion: typeof manifest.dataVersion === 'number' ? manifest.dataVersion : undefined,
      entries: Array.isArray(manifest.entries) ? manifest.entries : undefined
    }
  } catch {
    return null
  }
}

async function validateManifest(zip: JSZip): Promise<{ valid: boolean; error?: string }> {
  const manifest = await readManifest(zip)
  if (!manifest) {
    return { valid: false, error: '缺少 manifest.json 或格式损坏，无法识别备份文件' }
  }
  if (manifest.version > MANIFEST_VERSION) {
    return { valid: false, error: `不支持的备份版本：${manifest.version}（当前应用仅支持 v${MANIFEST_VERSION} 及以下）` }
  }
  return { valid: true }
}

async function clearDataDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true })
  } catch {
    // ignore
  }
  await fs.mkdir(dirPath, { recursive: true })
}

async function extractZipToDataDir(
  zip: JSZip,
  targetDir: string,
  prefix: string
): Promise<{ extracted: number; errors: string[] }> {
  const errors: string[] = []
  let extracted = 0

  const files = Object.values(zip.files).filter((entry) => !entry.dir)
  // 仅提取属于该前缀目录的文件（entry.name 形如 "<prefix>/..."），去掉前缀后写入目标目录，
  // 避免把所有目录的文件都写入同一个目标造成嵌套错乱。
  const normPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`
  for (const entry of files) {
    if (entry.name === 'manifest.json' || entry.name.startsWith('__MACOSX/')) {
      continue
    }
    if (!entry.name.startsWith(normPrefix)) continue
    const rel = entry.name.slice(normPrefix.length)
    if (!rel) continue

    try {
      const content = await entry.async('nodebuffer')
      const targetPath = path.join(targetDir, rel)
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await fs.writeFile(targetPath, content)
      extracted++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`${entry.name}: ${message}`)
    }
  }

  return { extracted, errors }
}

/** 还原 settings.json（单文件）。 */
async function extractSettings(zip: JSZip): Promise<{ ok: boolean; error?: string }> {
  const file = zip.file(SETTINGS_ZIP_PATH)
  if (!file) return { ok: false, error: '备份中未包含 settings.json' }
  try {
    const content = await file.async('nodebuffer')
    await fs.writeFile(getSettingsPath(), content)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

export async function importData(): Promise<ImportResult> {
  const window = await getFocusedWindow()
  if (!window) {
    return { success: false, error: '没有可用的窗口' }
  }

  const { filePaths, canceled } = await dialog.showOpenDialog(window, {
    title: '导入数据',
    filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
    properties: ['openFile']
  })

  if (canceled || !filePaths || filePaths.length === 0) {
    return { success: false }
  }

  const filePath = filePaths[0]

  try {
    const buffer = await fs.readFile(filePath)
    const zip = await JSZip.loadAsync(buffer)

    const validation = await validateManifest(zip)
    if (!validation.valid) {
      return { success: false, error: validation.error }
    }
    // v1 备份只含 notes/kb/todos/assets；v2 含全量。还原时统一按 DATA_ENTRIES 处理，
    // zip 中缺失的条目（v1 没有的部分）跳过即可，不会误清空。
    const hasSettings = zip.file(SETTINGS_ZIP_PATH) !== null

    // Confirm overwrite
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['导入并覆盖', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '导入确认',
      message: '导入将覆盖当前所有数据（含设置、历史、回收站、模板、主题等）。',
      detail: '导入前会自动创建当前数据的全量备份。是否继续？'
    })

    if (response !== 0) {
      return { success: false }
    }

    // Create backup
    const backupDir = path.dirname(filePath)
    const backupPath = await createBackupZip(backupDir)

    const allErrors: string[] = []

    // 逐目录清空并提取。zip 中若不含某前缀（如 v1 备份），extractZipToDataDir 不会写入，
    // 但 clearDataDir 仍会清空当前对应目录——为避免误删 v1 备份未覆盖的数据，
    // 仅对 zip 中实际存在的条目执行清空+还原。
    for (const entry of DATA_ENTRIES) {
      const prefix = entry.zipPrefix + '/'
      const hasEntry = Object.keys(zip.files).some((n) => n.startsWith(prefix))
      if (!hasEntry) continue
      await clearDataDir(entry.getDir())
      const result = await extractZipToDataDir(zip, entry.getDir(), entry.zipPrefix)
      allErrors.push(...result.errors)
    }

    // settings.json
    if (hasSettings) {
      const sResult = await extractSettings(zip)
      if (!sResult.ok && sResult.error) {
        allErrors.push(`settings.json: ${sResult.error}`)
      }
    }

    // Show backup info
    if (backupPath) {
      await dialog.showMessageBox(window, {
        type: 'info',
        title: '导入成功',
        message: '数据导入完成',
        detail: `当前数据已全量备份到：\n${backupPath}\n\n如需应用新设置（主题/编辑器模式等），请重启应用。`
      })
    }

    // 统计还原后数据
    const notesDir = getNotesDir()
    const kbDir = getKnowledgeBasesDir()
    const noteCount = await countNotes(notesDir)
    const { kbs: kbCount, docs: kbDocCount, whiteboards: whiteboardCount, annotations: annotationCount } =
      await countKnowledgeBasesAndDocs(kbDir)
    const todoCount = await countTodos()
    const historySnapshots = await countFilesInDir(getHistoryBaseDir())
    const templates = await countFilesInDir(getTemplatesDir())
    const themes = await countFilesInDir(getThemesDir())
    let trashItems = 0
    try {
      const trashRaw = await fs.readFile(path.join(getTrashDir(), 'trash.json'), 'utf-8')
      const parsed = JSON.parse(trashRaw)
      trashItems = Array.isArray(parsed) ? parsed.length : 0
    } catch {
      trashItems = 0
    }

    return {
      success: true,
      counts: {
        notes: noteCount,
        knowledgeBases: kbCount,
        kbDocs: kbDocCount,
        whiteboards: whiteboardCount,
        annotations: annotationCount,
        todos: todoCount,
        historySnapshots,
        trashItems,
        templates,
        themes
      },
      errors: allErrors.length > 0 ? allErrors : undefined
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `导入失败：${message}` }
  }
}
