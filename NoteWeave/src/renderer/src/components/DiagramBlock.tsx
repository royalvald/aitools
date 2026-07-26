import { useEffect, useState } from 'react'

// REQ-115 PlantUML / Graphviz 渲染（调用主进程本地后端）。
// 失败时回退显示源码与错误信息（与 MermaidDiagram 一致的体验）。

interface DiagramBlockProps {
  kind: 'plantuml' | 'graphviz'
  source: string
}

export function DiagramBlock({ kind, source }: DiagramBlockProps) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const fn =
      kind === 'plantuml'
        ? window.electronAPI.renderPlantUml(source)
        : window.electronAPI.renderGraphviz(source)
    fn.then((res) => {
      if (cancelled) return
      setLoading(false)
      if (res.ok && res.svg) setSvg(res.svg)
      else setError(res.error || '渲染失败')
    })
    return () => {
      cancelled = true
    }
  }, [kind, source])

  if (loading) {
    return (
      <div className="mermaid-block my-3 flex items-center justify-center surface-inset px-4 py-6 text-sm text-[var(--color-muted-foreground)]">
        正在渲染{kind === 'plantuml' ? ' PlantUML' : ' Graphviz'} 图表…
      </div>
    )
  }

  if (error) {
    return (
      <div className="mermaid-block mermaid-error my-3 rounded-md border px-4 py-3">
        <div className="mb-2 text-sm font-medium">{kind} 渲染失败</div>
        <pre className="overflow-auto text-xs">{error}</pre>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)]">
            源码
          </summary>
          <pre className="mt-1 overflow-auto text-xs">{source}</pre>
        </details>
      </div>
    )
  }

  return (
    <div
      className="mermaid-block my-3 flex justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-mermaid-bg)] px-4 py-4"
      // SVG 由主进程渲染后返回，可信（来自本地 PlantUML/Graphviz）
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  )
}
