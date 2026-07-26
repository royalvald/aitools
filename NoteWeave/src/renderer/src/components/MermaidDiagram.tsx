import { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'
import { useIsDark } from '../hooks/useIsDark'

// mermaid 配置为全局单例，渲染前按当前主题重新 initialize，保证主题切换后新渲染的图使用新主题。
function initMermaid(theme: 'default' | 'dark') {
  mermaid.initialize({
    startOnLoad: false,
    theme,
    securityLevel: 'strict',
    fontFamily: 'inherit'
  })
}

// 初始化为浅色（默认）主题，暗色下由组件渲染前重新初始化。
initMermaid('default')

interface MermaidDiagramProps {
  chart: string
}

/**
 * Mermaid 图表渲染组件（REQ-003）。
 *
 * - chart 变化时异步调用 mermaid.render(id, chart) 得到 SVG，注入容器。
 * - 渲染失败（语法错误等）回退为显示原始代码 + 错误提示，不阻断页面。
 * - mermaid.initialize 采用 securityLevel: 'strict'，禁用 html 标签避免 XSS。
 */
export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  // useId 保证同页多图 id 唯一；mermaid 要求 id 形如合法的 DOM id。
  const rawId = useId()
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 记录最新一次渲染请求，避免异步竞态导致旧结果覆盖新结果。
  const latestRef = useRef(0)
  // 主题切换（html.dark）时以对应 mermaid 主题重新渲染。
  const isDark = useIsDark()

  useEffect(() => {
    const trimmed = chart.trim()
    if (!trimmed) {
      setSvg(null)
      setError(null)
      return
    }

    const token = ++latestRef.current
    let cancelled = false

    // 渲染前同步全局主题；竞态由上面的 token/cancelled 防护。
    initMermaid(isDark ? 'dark' : 'default')

    mermaid
      .render(renderId, trimmed)
      .then(({ svg }) => {
        if (cancelled || token !== latestRef.current) return
        setSvg(svg)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled || token !== latestRef.current) return
        setSvg(null)
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [chart, renderId, isDark])

  if (error) {
    return (
      <div className="mermaid-block mermaid-block-error">
        <div className="mermaid-error-label">图表渲染失败（已显示源码）</div>
        <pre>
          <code>{chart}</code>
        </pre>
        <div className="mermaid-error-detail">{error}</div>
      </div>
    )
  }

  if (!svg) {
    // 渲染中占位
    return <div className="mermaid-block mermaid-block-loading">图表渲染中…</div>
  }

  return (
    <div
      className="mermaid-block"
      // svg 来自本地 mermaid 渲染、securityLevel=strict，且不含 <script>，可安全注入
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
