import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

// 全局错误边界：任何子树在渲染期抛出未捕获异常时，避免整棵 React 树被卸载导致白屏，
// 改为显示可恢复的占位界面，并暴露错误信息便于排查。
// 注意：ErrorBoundary 只能用 class 组件实现（Hooks 无 getDerivedStateFromError 对应物）。
interface ErrorBoundaryProps {
  children: ReactNode
  /** 局部边界可选的自定义回退渲染；不传则用默认全屏回退 */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 输出到控制台，便于开发期定位；生产期可在此接入日志上报
    console.error('[ErrorBoundary] 渲染异常：', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  reload = (): void => {
    window.location.reload()
  }

  copyDetails = async (): Promise<void> => {
    const { error } = this.state
    if (!error) return
    const text = `${error.name}: ${error.message}\n\n${error.stack ?? ''}`
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // 剪贴板不可用时静默忽略
    }
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
        <AlertTriangle className="h-10 w-10 text-[var(--color-warning,#f59e0b)]" />
        <div className="space-y-1">
          <h2 className="text-lg font-semibold text-[var(--color-foreground)]">界面渲染出错</h2>
          <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
            当前内容加载时遇到异常。可以尝试重试，或重新加载窗口；如果问题持续，请复制下方错误信息反馈。
          </p>
        </div>
        <pre className="surface-elevated max-w-2xl overflow-auto rounded-md p-3 text-left font-mono text-xs text-[var(--color-muted-foreground)]">
          {error.name}: {error.message}
        </pre>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button onClick={this.reset} className="btn-primary">
            <RotateCw className="h-4 w-4" />
            重试
          </button>
          <button onClick={this.reload} className="btn-secondary">
            重新加载窗口
          </button>
          <button onClick={this.copyDetails} className="btn-ghost">
            复制错误详情
          </button>
        </div>
      </div>
    )
  }
}
