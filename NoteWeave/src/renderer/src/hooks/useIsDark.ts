import { useSyncExternalStore } from 'react'

/**
 * 返回当前 <html> 是否带有 .dark class。
 * 订阅 class 属性变化，可实时响应主题切换。
 */
export function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class']
      })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains('dark'),
    () => false
  )
}
