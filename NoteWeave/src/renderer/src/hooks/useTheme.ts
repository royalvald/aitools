import { useEffect } from 'react'
import { useSettings } from './useSettings'

// REQ-010/REQ-111 主题/暗色模式：根据 settings.theme 决定 <html> 是否挂 dark class。
// - light：始终亮色
// - dark：始终暗色
// - system：跟随系统 prefers-color-scheme，并监听其变化
// - 自定义主题名：先按 isDark 切换 dark class，再注入该主题的 CSS（覆盖 --nw-* 变量）
// 由 useSettings 驱动，全应用只读 settings 即可同步主题。
const BUILTIN_THEMES = ['light', 'dark', 'system']

export function useTheme(): void {
  const { settings } = useSettings()
  const theme = settings.theme

  useEffect(() => {
    const root = document.documentElement
    const isCustom = !BUILTIN_THEMES.includes(theme)

    const resolveDark = async (): Promise<boolean> => {
      if (isCustom) {
        const themes = await window.electronAPI.listThemes()
        const t = themes.find((x) => x.id === theme)
        return !!t?.isDark
      }
      if (theme === 'dark') return true
      if (theme === 'light') return false
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }

    let active = true
    const apply = async () => {
      const dark = await resolveDark()
      if (!active) return
      if (dark) {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }

    apply()

    // REQ-111：注入自定义主题 CSS
    if (isCustom) {
      window.electronAPI.resolveThemeCss(theme).then((css) => {
        if (!active || !css) return
        let el = document.getElementById('custom-theme-css') as HTMLStyleElement | null
        if (!el) {
          el = document.createElement('style')
          el.id = 'custom-theme-css'
          document.head.appendChild(el)
        }
        el.textContent = css
      })
    } else {
      const el = document.getElementById('custom-theme-css')
      if (el) el.textContent = ''
    }

    if (theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      // add/remove 必须共用同一个 handler 引用，否则监听器永远移除不掉。
      const onChange = () => void apply()
      mql.addEventListener('change', onChange)
      return () => {
        active = false
        mql.removeEventListener('change', onChange)
      }
    }
    return () => {
      active = false
    }
  }, [theme])
}

/** 给定主题设置，返回当前实际生效是否为暗色（供需要同步的第三方库使用）。 */
export function isDarkResolved(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}
