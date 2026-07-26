import { useCallback, useEffect, useState } from 'react'
import type { FavoriteItem } from '../types'

// REQ-201 收藏夹。进程内单例缓存：多组件共用一次 IPC 加载，增删后广播给全部订阅者。

interface FavoriteKey {
  kind: 'note' | 'kbDoc'
  id: string
}

let cached: FavoriteItem[] | null = null
let loadingPromise: Promise<FavoriteItem[]> | null = null
const listeners = new Set<(items: FavoriteItem[]) => void>()

async function loadFavorites(): Promise<FavoriteItem[]> {
  if (cached) return cached
  if (!loadingPromise) {
    loadingPromise = window.electronAPI.listFavorites().then((items) => {
      cached = items
      loadingPromise = null
      return items
    })
  }
  return loadingPromise
}

function broadcast(items: FavoriteItem[]) {
  cached = items
  for (const l of listeners) l(items)
}

const keyOf = (k: FavoriteKey) => `${k.kind}:${k.id}`

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>(cached ?? [])

  useEffect(() => {
    listeners.add(setFavorites)
    if (!cached) {
      loadFavorites().then(setFavorites).catch(() => {})
    } else {
      setFavorites(cached)
    }
    return () => {
      listeners.delete(setFavorites)
    }
  }, [])

  const refresh = useCallback(async () => {
    const items = await window.electronAPI.listFavorites()
    broadcast(items)
    return items
  }, [])

  const addFavorite = useCallback(
    async (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => {
      const items = await window.electronAPI.addFavorite(item)
      broadcast(items)
      return items
    },
    []
  )

  const removeFavorite = useCallback(async (kind: 'note' | 'kbDoc', id: string) => {
    const items = await window.electronAPI.removeFavorite(kind, id)
    broadcast(items)
    return items
  }, [])

  const isFavorite = useCallback(
    (kind: 'note' | 'kbDoc', id: string) =>
      favorites.some((f) => f.kind === kind && f.id === id),
    [favorites]
  )

  const toggle = useCallback(
    (item: { kind: 'note' | 'kbDoc'; id: string; kbId?: string; title: string }) => {
      const exists = favorites.some((f) => keyOf(f) === keyOf(item))
      if (exists) {
        return removeFavorite(item.kind, item.id)
      }
      return addFavorite(item)
    },
    [favorites, addFavorite, removeFavorite]
  )

  return { favorites, isFavorite, addFavorite, removeFavorite, toggle, refresh }
}
