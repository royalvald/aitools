import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Combine,
  Split,
  Trash2
} from 'lucide-react'
import type { MilkdownEditorApi } from './MilkdownEditor'

// REQ-105：表格浮动工具栏。当选区位于表格单元格内时显示，提供增删行列与对齐。
// 依赖 MilkdownEditor 暴露的 runTableCommand / isInTable 命令接口。
// Tab / Shift+Tab 单元格导航由 Milkdown 内置 tableKeymap 提供（无需重复实现）。

interface TableToolbarProps {
  api: MilkdownEditorApi | null
}

export function TableToolbar({ api }: TableToolbarProps) {
  const [visible, setVisible] = useState(false)
  const [canMerge, setCanMerge] = useState(false)
  const [canSplit, setCanSplit] = useState(false)

  useEffect(() => {
    if (!api) {
      setVisible(false)
      return
    }
    const check = () => {
      // 编辑器异步创建完成前，命令接口可能尚未就绪；视为不在表格内即可
      try {
        setVisible(api.isInTable())
        setCanMerge(api.hasCellSelection())
        setCanSplit(api.isMergedCell())
      } catch {
        setVisible(false)
      }
    }
    check()
    document.addEventListener('selectionchange', check)
    const pm = document.querySelector('.ProseMirror') as HTMLElement | null
    pm?.addEventListener('click', check)
    pm?.addEventListener('keyup', check)
    return () => {
      document.removeEventListener('selectionchange', check)
      pm?.removeEventListener('click', check)
      pm?.removeEventListener('keyup', check)
    }
  }, [api])

  if (!visible || !api) return null

  const Btn = ({
    onClick,
    title,
    children,
    disabled
  }: {
    onClick: () => void
    title: string
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <button
      type="button"
      title={disabled ? `${title}（当前不可用）` : title}
      disabled={disabled}
      className="rounded p-1 text-[var(--color-muted-foreground)] hover:bg-[var(--color-ghost-hover)] hover:text-[var(--color-foreground)] disabled:opacity-30 disabled:hover:bg-transparent"
      onClick={onClick}
    >
      {children}
    </button>
  )

  return (
    <div
      className="table-toolbar fixed z-50 flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 shadow-lg"
      style={{ top: 80, left: '50%', transform: 'translateX(-50%)' }}
    >
      <Btn title="上方插入行" onClick={() => api.runTableCommand('addRowBefore')}>
        <ArrowUp size={14} />
      </Btn>
      <Btn title="下方插入行" onClick={() => api.runTableCommand('addRowAfter')}>
        <ArrowDown size={14} />
      </Btn>
      <span className="divider mx-0.5 h-4 w-px" />
      <Btn title="左侧插入列" onClick={() => api.runTableCommand('addColBefore')}>
        <ArrowLeft size={14} />
      </Btn>
      <Btn title="右侧插入列" onClick={() => api.runTableCommand('addColAfter')}>
        <ArrowRight size={14} />
      </Btn>
      <span className="divider mx-0.5 h-4 w-px" />
      <Btn
        title="合并单元格（先拖选多个单元格）"
        onClick={() => api.runTableCommand('mergeCells')}
        disabled={!canMerge}
      >
        <Combine size={14} />
      </Btn>
      <Btn
        title="拆分单元格"
        onClick={() => api.runTableCommand('splitCell')}
        disabled={!canSplit}
      >
        <Split size={14} />
      </Btn>
      <span className="divider mx-0.5 h-4 w-px" />
      <Btn title="左对齐" onClick={() => api.runTableCommand('alignLeft')}>
        <AlignLeft size={14} />
      </Btn>
      <Btn title="居中" onClick={() => api.runTableCommand('alignCenter')}>
        <AlignCenter size={14} />
      </Btn>
      <Btn title="右对齐" onClick={() => api.runTableCommand('alignRight')}>
        <AlignRight size={14} />
      </Btn>
      <span className="divider mx-0.5 h-4 w-px" />
      <Btn title="删除行/列（按当前选区）" onClick={() => api.runTableCommand('deleteCells')}>
        <Trash2 size={14} />
      </Btn>
    </div>
  )
}
