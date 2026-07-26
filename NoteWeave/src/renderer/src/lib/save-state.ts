import { useSyncExternalStore } from 'react'

// 统一保存模型：自动保存是唯一保存路径。
//
// useNotes / useKnowledgeBaseDocs 在自动保存生命周期的各阶段向本模块上报状态，
// NoteDetail / KbDocEditor 通过 useSaveStatus 订阅同一来源，StatusBar 的
// 「未保存 / 保存中 / 已保存」三态因此真实反映自动保存进度，而不是各自维护
// 互相矛盾的本地快照。

export type SaveState = 'unsaved' | 'saving' | 'saved'

export interface SaveStatus {
  state: SaveState
  /** 最近一次保存完成时间（ms 时间戳）；未保存过为 null。 */
  savedAt: number | null
}

const store = new Map<string, SaveStatus>()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** 上报某文档的保存状态（由数据 Hooks 调用）。 */
export function reportSaveStatus(key: string, status: SaveStatus) {
  const prev = store.get(key)
  if (prev && prev.state === status.state && prev.savedAt === status.savedAt) return
  store.set(key, status)
  emit()
}

/** 清除某文档的保存状态（文档删除时调用）。 */
export function clearSaveStatus(key: string) {
  if (store.delete(key)) emit()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const FALLBACK: SaveStatus = { state: 'saved', savedAt: null }

/** 订阅某文档的保存状态；key 为 null 时返回「已保存」占位。 */
export function useSaveStatus(key: string | null): SaveStatus {
  return useSyncExternalStore(subscribe, () => (key ? (store.get(key) ?? FALLBACK) : FALLBACK))
}

export const noteSaveKey = (noteId: string) => `note:${noteId}`
export const kbDocSaveKey = (docId: string) => `kbDoc:${docId}`
