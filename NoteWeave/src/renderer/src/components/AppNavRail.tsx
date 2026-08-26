import { House, Images, Library, Search, Settings, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { ThemeToggle } from './ThemeToggle'

export interface AppNavRailProps {
  view: 'dashboard' | 'knowledge-base'
  onNavigate: (view: 'dashboard' | 'knowledge-base') => void
  onOpenSearch: () => void
  onOpenTrash: () => void
  onOpenAssets: () => void
  onOpenSettings: () => void
}

// 语雀式左侧固定图标导航栏：顶部 logo，中间主导航，底部工具入口。
// UE-01/§2.1：无「数据」入口——数据导入导出收进设置对话框「数据」分区（UE-18）。
export function AppNavRail({
  view,
  onNavigate,
  onOpenSearch,
  onOpenTrash,
  onOpenAssets,
  onOpenSettings
}: AppNavRailProps) {
  return (
    <aside className="nav-rail">
      {/* 顶部 logo */}
      <div
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--nw-primary)] text-sm font-semibold text-white"
        title="织记 NoteWeave"
      >
        织
      </div>

      {/* 主导航 */}
      <div className="mt-6 flex w-full flex-col items-center gap-1">
        <button
          type="button"
          className={cn('nav-rail-item flex w-full flex-col items-center gap-1', view === 'dashboard' && 'is-active')}
          title="工作台"
          onClick={() => onNavigate('dashboard')}
        >
          <House className="h-5 w-5" />
        </button>
        <button
          type="button"
          className={cn('nav-rail-item flex w-full flex-col items-center gap-1', view === 'knowledge-base' && 'is-active')}
          title="知识库"
          onClick={() => onNavigate('knowledge-base')}
        >
          <Library className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1" />

      {/* 底部工具 */}
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          className="nav-rail-item"
          title="全局搜索（Ctrl+Shift+F）"
          onClick={onOpenSearch}
        >
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="nav-rail-item"
          title="资源管理"
          onClick={onOpenAssets}
        >
          <Images className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="nav-rail-item"
          title="回收站"
          onClick={onOpenTrash}
        >
          <Trash2 className="h-5 w-5" />
        </button>
        <ThemeToggle collapsed />
        <button
          type="button"
          className="nav-rail-item"
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>
    </aside>
  )
}
