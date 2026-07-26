import { useEffect, useState } from 'react'

/**
 * 响应式布局：监听窗口宽度（resize 防抖一帧）。
 * 用于窄窗口下自动收起右侧大纲/讨论面板、收窄目录树等自适应行为。
 */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    let raf = 0
    const onResize = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return width
}
