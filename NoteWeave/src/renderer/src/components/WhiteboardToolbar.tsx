import {
  ChevronDown,
  Code2,
  Download,
  FileCode,
  FileDown,
  FileImage,
  FileText,
  Minus,
  Plus,
  Presentation,
  RotateCcw,
  Undo2,
  Redo2
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '../lib/utils'
import { formatScale } from '../lib/whiteboard'
import { WhiteboardTimerButton } from './WhiteboardTimerPanel'

interface WhiteboardToolbarProps {
  scale: number
  onScaleChange: (scale: number) => void
  editableContent?: boolean
  sourceMode?: boolean
  onToggleSourceMode?: () => void
  onZoomToFit?: () => void
  /** REQ-224 按框架顺序演示 */
  onPresentFrames?: () => void
  /** REQ-224 导出框架为 PDF */
  onExportFramesPdf?: () => void
  /** REQ-224 框架数量（用于禁用按钮） */
  frameCount?: number
  /** REQ-228 导出（格式由调用方决定） */
  onExport?: (format: 'png' | 'svg' | 'markdown') => void
  /** 撤销/重做（内存历史栈） */
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
}

// 分组分隔线
function Separator() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-[var(--color-border)]" />
}

export function WhiteboardToolbar({
  scale,
  onScaleChange,
  editableContent,
  sourceMode,
  onToggleSourceMode,
  onZoomToFit,
  onPresentFrames,
  onExportFramesPdf,
  frameCount,
  onExport,
  onUndo,
  onRedo,
  canUndo,
  canRedo
}: WhiteboardToolbarProps) {
  const [exportOpen, setExportOpen] = useState(false)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2">
      <div className="flex flex-wrap items-center gap-1">
        {/* 撤销/重做 */}
        {(onUndo || onRedo) && (
          <>
            <button onClick={onUndo} disabled={!canUndo} className="btn-icon disabled:opacity-40" title="撤销 (Ctrl+Z)">
              <Undo2 className="h-4 w-4" />
            </button>
            <button onClick={onRedo} disabled={!canRedo} className="btn-icon disabled:opacity-40" title="重做 (Ctrl+Shift+Z)">
              <Redo2 className="h-4 w-4" />
            </button>
          </>
        )}

        {(editableContent && onToggleSourceMode) || onPresentFrames || onExportFramesPdf ? <Separator /> : null}

        {editableContent && onToggleSourceMode && (
          <button
            onClick={onToggleSourceMode}
            className={cn(
              'flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              sourceMode ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]' : 'bg-[var(--color-muted)] text-[var(--color-foreground)] hover:bg-[var(--color-border-strong)]'
            )}
          >
            <Code2 className="h-4 w-4" />
            {sourceMode ? '可视编辑' : '源码模式'}
          </button>
        )}
        {onPresentFrames && (
          <button
            onClick={onPresentFrames}
            disabled={!frameCount}
            className="btn-ghost disabled:opacity-40"
            title="按框架顺序全屏演示"
          >
            <Presentation className="h-4 w-4" />
            框架演示
          </button>
        )}
        {onExportFramesPdf && (
          <button
            onClick={onExportFramesPdf}
            disabled={!frameCount}
            className="btn-ghost disabled:opacity-40"
            title="导出框架为 PDF（每帧一页）"
          >
            <FileDown className="h-4 w-4" />
            导出PDF
          </button>
        )}

        {onExport && <Separator />}

        {onExport && (
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              className="btn-ghost"
              title="导出白板"
            >
              <Download className="h-4 w-4" />
              导出
              <ChevronDown className="h-3 w-3" />
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1 w-40 surface-elevated py-1 text-sm">
                  <button
                    onClick={() => { setExportOpen(false); onExport('png') }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-2)]"
                  >
                    <FileImage className="h-4 w-4 text-[var(--color-muted-foreground)]" /> PNG 图片
                  </button>
                  <button
                    onClick={() => { setExportOpen(false); onExport('svg') }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-2)]"
                  >
                    <FileCode className="h-4 w-4 text-[var(--color-muted-foreground)]" /> SVG 矢量
                  </button>
                  <button
                    onClick={() => { setExportOpen(false); onExport('markdown') }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-2)]"
                  >
                    <FileText className="h-4 w-4 text-[var(--color-muted-foreground)]" /> Markdown 大纲
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1">
        {/* REQ-226 计时器：内嵌工具栏，不再浮动在画布上 */}
        <WhiteboardTimerButton />
        {onZoomToFit && (
          <button
            onClick={onZoomToFit}
            className="btn-icon mr-1"
            title="缩放到 100%"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => onScaleChange(scale - 0.1)}
          className="btn-icon"
          title="缩小"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="min-w-[48px] text-center text-sm text-[var(--color-muted-foreground)]">{formatScale(scale)}</span>
        <button
          onClick={() => onScaleChange(scale + 0.1)}
          className="btn-icon"
          title="放大"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
