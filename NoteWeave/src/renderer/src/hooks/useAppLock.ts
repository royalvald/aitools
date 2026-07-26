import { useCallback, useEffect, useState } from 'react'

// REQ-208 应用锁屏状态管理。
// - 启动时若 settings.appLock.enabled，则进入 locked 态，需输入密码解锁。
// - locked 仅在主窗口（非白板展示窗口）生效。
// - 仅当 appLock 配置存在且 enabled 时才视为已开启。

interface AppLockState {
  enabled: boolean
  locked: boolean
}

let cachedState: AppLockState | null = null
const listeners = new Set<(s: AppLockState) => void>()

function broadcast(s: AppLockState) {
  cachedState = s
  for (const l of listeners) l(s)
}

async function loadState(): Promise<AppLockState> {
  const settings = await window.electronAPI.getSettings()
  const enabled = !!(settings.appLock && settings.appLock.enabled)
  // 启动时若已开启，默认锁屏
  return { enabled, locked: enabled }
}

export function useAppLock() {
  const [state, setState] = useState<AppLockState>(cachedState ?? { enabled: false, locked: false })

  useEffect(() => {
    listeners.add(setState)
    if (!cachedState) {
      loadState().then(setState).catch(() => {})
    } else {
      setState(cachedState)
    }
    return () => {
      listeners.delete(setState)
    }
  }, [])

  const refresh = useCallback(async () => {
    broadcast(await loadState())
  }, [])

  const lockNow = useCallback(() => {
    if (state.enabled) broadcast({ ...state, locked: true })
  }, [state])

  const unlock = useCallback(async (password: string): Promise<boolean> => {
    const ok = await window.electronAPI.verifyAppLock(password)
    if (ok) broadcast({ enabled: true, locked: false })
    return ok
  }, [])

  const enable = useCallback(async (password: string): Promise<boolean> => {
    await window.electronAPI.setAppLock(password)
    broadcast({ enabled: true, locked: false })
    return true
  }, [])

  const disable = useCallback(async (password: string): Promise<boolean> => {
    const ok = await window.electronAPI.clearAppLock(password)
    if (ok) broadcast({ enabled: false, locked: false })
    return ok
  }, [])

  return {
    enabled: state.enabled,
    locked: state.locked,
    lockNow,
    unlock,
    enable,
    disable,
    refresh
  }
}
