import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Lock,
  LockOpen,
  PanelRight,
  Pencil,
  Star,
  type LucideIcon
} from 'lucide-react'
import { cn } from '../lib/utils'

export interface DocPageHeaderProps {
  /** 面包屑分段，如 ['知识库名', '文档名'] 或 ['小记', '标题'] */
  breadcrumb: string[]
  /** 返回按钮（面包屑左侧箭头）；不传则不显示 */
  onBack?: () => void
  /** 阅读/编辑态 */
  editing: boolean
  onEnterEdit?: () => void
  onExitEdit?: () => void
  isFavorite?: boolean
  onToggleFavorite?: () => void
  locked?: boolean
  onToggleLock?: () => void
  outlineAvailable?: boolean
  outlineOpen?: boolean
  onToggleOutline?: () => void
  /** 编辑态附加控件（如 EditorModeSwitcher），插入在右侧按钮组之前 */
  extraActions?: React.ReactNode
  /** 「···」更多菜单内容（调用方传入下拉面板 ReactNode，自行管理开闭）；简单起见也可以直接传一个完整按钮组件 */
  moreActions?: React.ReactNode
}

/**
 * 语雀式文档页头：面包屑 + 右侧操作区（收藏 / 锁定 / 大纲 / 更多 / 编辑·预览）。
 * 阅读优先：阅读态主操作是「编辑」，编辑态主操作是「预览」（返回阅读）。
 */
export function DocPageHeader({
  breadcrumb,
  onBack,
  editing,
  onEnterEdit,
  onExitEdit,
  isFavorite,
  onToggleFavorite,
  locked,
  onToggleLock,
  outlineAvailable,
  outlineOpen,
  onToggleOutline,
  extraActions,
  moreActions
}: DocPageHeaderProps) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--nw-border)] bg-[var(--nw-surface)] px-4">
      {onBack && (
        <button onClick={onBack} className="btn-icon flex-shrink-0" title="返回">
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}

      {/* 面包屑：除最后一段外均为弱化色，最后一段为当前文档名 */}
      <div className="flex min-w-0 items-center gap-1 text-sm">
        {breadcrumb.map((seg, i) => {
          const last = i === breadcrumb.length - 1
          return (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[var(--nw-muted-foreground)]" />
              )}
              <span
                className={
                  last
                    ? 'truncate font-medium text-[var(--nw-foreground)]'
                    : 'flex-shrink-0 text-[var(--nw-muted-foreground)]'
                }
              >
                {seg}
              </span>
            </span>
          )
        })}
      </div>

      <div className="ml-auto flex items-center gap-1">
        {extraActions}

        {onToggleFavorite && (
          <button
            onClick={onToggleFavorite}
            className={cn('btn-icon', isFavorite && 'text-amber-500')}
            title={isFavorite ? '取消收藏' : '加入收藏'}
          >
            <Star className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
        )}

        {onToggleLock && (
          <button
            onClick={onToggleLock}
            className={cn('btn-icon', locked && 'text-[var(--nw-primary)]')}
            title={locked ? '已锁定（点击解锁）' : '锁定（只读）'}
          >
            {locked ? <Lock className="h-4 w-4" /> : <LockOpen className="h-4 w-4" />}
          </button>
        )}

        {outlineAvailable && onToggleOutline && (
          <button
            onClick={onToggleOutline}
            className={cn('btn-icon', outlineOpen && 'is-active')}
            title={outlineOpen ? '隐藏大纲' : '显示大纲'}
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}

        {moreActions}

        {editing ? (
          <button onClick={onExitEdit} className="btn-primary" title="完成编辑，返回预览">
            <Eye className="h-4 w-4" />
            预览
          </button>
        ) : (
          <button
            onClick={onEnterEdit}
            disabled={locked}
            className="btn-primary"
            title={locked ? '文档已锁定' : '编辑'}
          >
            <Pencil className="h-4 w-4" />
            编辑
          </button>
        )}
      </div>
    </div>
  )
}

interface DropdownItemProps {
  onClick: () => void
  icon: LucideIcon
  label: string
  shortcut?: string
  active?: boolean
  /** 危险操作（如删除）：红色文本，一般置底 */
  danger?: boolean
}

/** 「···」更多菜单的通用菜单项（供 DocPageHeader.moreActions 下拉使用）。 */
export function DropdownItem({ onClick, icon: Icon, label, shortcut, active, danger }: DropdownItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
        danger
          ? 'text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]'
          : active
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-primary)]'
            : 'text-[var(--color-foreground)] hover:bg-[var(--color-surface-2)]'
      )}
    >
      <Icon className={cn('h-4 w-4 flex-shrink-0', danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted-foreground)]')} />
      <span className="flex-1">{label}</span>
      {shortcut && <span className="text-[11px] text-[var(--color-muted-foreground)]">{shortcut}</span>}
      {active && !danger && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />}
    </button>
  )
}
