import { useEffect, useState, type RefObject } from 'react'

/**
 * 根据容器实际宽度计算网格列数。用于替代 Tailwind 默认断点
 * （在 Electron 固定 minWidth 下，默认断点会退化失效）。
 *
 * @param containerRef 容器 ref
 * @param minColumnWidth 每列最小宽度（px）
 * @param gap 列间距（px），默认 12
 * @param maxColumns 最大列数，默认不限制
 */
export function useGridColumns(
  containerRef: RefObject<HTMLElement | null>,
  minColumnWidth: number,
  gap = 12,
  maxColumns = Infinity
): number {
  const [columns, setColumns] = useState(1)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const compute = () => {
      const width = el.clientWidth
      // 列数 = floor((width + gap) / (minColumnWidth + gap))，至少 1
      const cols = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
      setColumns(Math.min(cols, maxColumns))
    }

    compute()
    const ro = new ResizeObserver(() => compute())
    ro.observe(el)
    return () => ro.disconnect()
  }, [containerRef, minColumnWidth, gap, maxColumns])

  return columns
}
