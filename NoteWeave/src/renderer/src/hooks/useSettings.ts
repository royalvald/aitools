import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, EditorMode } from '../types'

// 进程内设置缓存：多个组件（NoteDetail / KbDocEditor / CodeBlock）会同时读取设置，
// 这里用一个模块级单例避免重复 IPC 往返，并在首次访问时加载一次。
let cachedSettings: AppSettings | null = null
let loadingPromise: Promise<AppSettings> | null = null
const listeners = new Set<(s: AppSettings) => void>()

/** 默认设置（与主进程 DEFAULT_SETTINGS 保持一致，用于 IPC 完成前的首次渲染兜底）。 */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  defaultEditorMode: 'wysiwyg',
  autoSaveDebounceMs: 500,
  maxHistoryVersions: 30,
  enableLineNumbers: false,
  enableSpellCheck: false,
  enableAutoPair: true,
  enableFocusMode: false,
  enableTypewriterMode: false,
  enableLint: false,
  enablePlantUMLServer: false,
  diagramBackend: 'local',
  pandocPath: null,
  pandocArgs: [],
  pinnedItems: [],
  recentItems: [],
  commandHistory: [],
  favorites: [],
  appLock: null,
  searchHistory: [],
  ocrEnabled: false,
  quickNote: { enabled: true, shortcut: 'Ctrl+Shift+N', defaultGroupId: null },
  localApi: { enabled: false, port: 0, token: '' },
  webClip: { enabled: false, defaultGroupId: null },
  ollama: { enabled: false, url: 'http://127.0.0.1:11434', model: '' }
}

async function loadSettings(): Promise<AppSettings> {
  if (cachedSettings) return cachedSettings
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    try {
      const s = await window.electronAPI.getSettings()
      cachedSettings = s
      return s
    } catch {
      cachedSettings = { ...DEFAULT_SETTINGS }
      return cachedSettings
    } finally {
      loadingPromise = null
    }
  })()
  return loadingPromise
}

/**
 * 失效进程内设置缓存并从主进程重新加载，广播给所有订阅者。
 * 用于「导入数据」还原 settings.json 后让界面立即应用新设置（主题/编辑器模式等）。
 */
export async function reloadSettings(): Promise<AppSettings> {
  cachedSettings = null
  loadingPromise = null
  const s = await loadSettings()
  listeners.forEach((l) => l(s))
  return s
}

/**
 * 应用设置 Hook。
 * - 挂载时从主进程加载一次（带进程内缓存）。
 * - `update` 会立即更新本地缓存并广播给所有订阅者，同时异步落盘到 settings.json。
 *   `update` 接收部分字段，与现有设置浅合并。
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(
    cachedSettings ?? { ...DEFAULT_SETTINGS }
  )

  useEffect(() => {
    let mounted = true
    const listener = (s: AppSettings) => {
      if (mounted) setSettings(s)
    }
    listeners.add(listener)
    loadSettings().then((s) => {
      if (mounted) setSettings(s)
    })
    return () => {
      mounted = false
      listeners.delete(listener)
    }
  }, [])

  const update = useCallback(
    (partial: Partial<AppSettings>) => {
      const next: AppSettings = { ...(cachedSettings ?? settings), ...partial }
      cachedSettings = next
      setSettings(next)
      listeners.forEach((l) => l(next))
      // 异步落盘，失败仅忽略（不影响当前会话使用）
      window.electronAPI.saveSettings(next).catch(() => {})
    },
    [settings]
  )

  const setEditorMode = useCallback(
    (mode: EditorMode) => {
      update({ defaultEditorMode: mode })
    },
    [update]
  )

  return { settings, update, setEditorMode } as const
}
