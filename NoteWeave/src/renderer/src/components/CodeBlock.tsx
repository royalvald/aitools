import { useState } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy } from 'lucide-react'
import { useIsDark } from '../hooks/useIsDark'

interface CodeBlockProps {
  language: string
  value: string
  showLineNumbers?: boolean
}

/**
 * 代码块渲染（REQ-009）。
 * - 使用 react-syntax-highlighter 的 Prism 构建，支持 50+ 语言。
 * - 右上角显示语言标签 + 一键复制按钮。
 * - 行号显示由 settings.enableLineNumbers 控制。
 *
 * 采用 react-syntax-highlighter 的 oneLight / oneDark 主题，
 * 根据当前主题自动切换；颜色细节在 index.css 内进一步覆盖。
 */
export function CodeBlock({ language, value, showLineNumbers = false }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const isDark = useIsDark()

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板不可用时静默失败（如部分安全策略限制）
    }
  }

  return (
    <div className="code-block group relative">
      <div className="code-block-toolbar">
        <span className="code-block-lang">{language || 'text'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="code-block-copy"
          title="复制代码"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={isDark ? oneDark : oneLight}
        showLineNumbers={showLineNumbers}
        customStyle={{
          margin: 0,
          borderRadius: '0 0 6px 6px',
          fontSize: '0.85rem',
          background: 'transparent'
        }}
        codeTagProps={{ style: { fontFamily: 'inherit' } }}
      >
        {value}
      </SyntaxHighlighter>
    </div>
  )
}
