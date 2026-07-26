import { useEffect, useState } from 'react'
import { Check, Star, Trash2 } from 'lucide-react'
import { Modal } from './Modal'
import type { WhiteboardTemplate, TemplateElement } from '../../../shared/wb-templates'

// REQ-225 白板模板选择弹窗：网格预览 + 应用。
interface WhiteboardTemplatePickerProps {
  open: boolean
  onClose: () => void
  onApply: (template: WhiteboardTemplate) => void
}

export function WhiteboardTemplatePicker({ open, onClose, onApply }: WhiteboardTemplatePickerProps) {
  const [templates, setTemplates] = useState<WhiteboardTemplate[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    window.electronAPI.listWbTemplates().then((list) => setTemplates(list as WhiteboardTemplate[]))
  }, [open])

  if (!open) return null

  const apply = () => {
    const t = templates.find((x) => x.id === selected)
    if (t) onApply(t)
    onClose()
  }

  return (
    <Modal title="白板模板" onClose={onClose}>
      <div className="max-h-[70vh] overflow-y-auto">
        <div className="grid grid-cols-3 gap-3">
          {templates.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={`group flex flex-col rounded-lg border p-2 text-left transition-colors ${
                selected === t.id
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-ghost-hover)]'
              }`}
            >
              <TemplatePreview elements={t.elements} />
              <div className="mt-1.5 flex items-center gap-1">
                <span className="truncate text-sm font-medium text-[var(--color-foreground)]">{t.name}</span>
                {!t.builtin && <Star className="h-3 w-3 flex-shrink-0 text-amber-400" />}
              </div>
              <div className="truncate text-[11px] text-[var(--color-muted-foreground)]">{t.description}</div>
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs text-[var(--color-muted-foreground)]">
          {selected ? `已选：${templates.find((x) => x.id === selected)?.name}` : '选择一个模板（应用会覆盖当前白板内容）'}
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary">
            取消
          </button>
          <button onClick={apply} disabled={!selected} className="btn-primary disabled:opacity-50">
            应用模板
          </button>
        </div>
      </div>
    </Modal>
  )
}

// 模板缩略预览：把元素绘制为小尺寸 SVG（缩放到 200×120 画布）
function TemplatePreview({ elements }: { elements: TemplateElement[] }) {
  if (!elements || elements.length === 0) {
    return <div className="h-28 rounded bg-[var(--color-surface-2)] text-center text-[10px] leading-28 text-[var(--color-muted-foreground)]/60">空白</div>
  }
  // 计算包围盒
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of elements) {
    const b = el as unknown as { x?: number; y?: number; width?: number; height?: number }
    minX = Math.min(minX, b.x ?? 0)
    minY = Math.min(minY, b.y ?? 0)
    maxX = Math.max(maxX, (b.x ?? 0) + (b.width ?? 0))
    maxY = Math.max(maxY, (b.y ?? 0) + (b.height ?? 0))
  }
  if (!Number.isFinite(minX)) {
    minX = 0; minY = 0; maxX = 100; maxY = 60
  }
  const bw = maxX - minX || 100
  const bh = maxY - minY || 60
  const scale = Math.min(200 / bw, 112 / bh, 0.5)
  const offsetX = (200 - bw * scale) / 2
  const offsetY = (112 - bh * scale) / 2
  const parts: string[] = []
  for (const el of elements) {
    const b = el as unknown as { type?: string; x?: number; y?: number; width?: number; height?: number; color?: string; shape?: string; text?: string }
    const x = offsetX + ((b.x ?? 0) - minX) * scale
    const y = offsetY + ((b.y ?? 0) - minY) * scale
    const w = (b.width ?? 0) * scale
    const h = (b.height ?? 0) * scale
    if (el.type === 'sticky') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${b.color ?? '#fef9c3'}" stroke="#e2e8f0"/>`)
    } else if (el.type === 'shape') {
      parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="#fff" stroke="#94a3b8"/>`)
    } else if (el.type === 'text') {
      const safe = (b.text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      parts.push(`<text x="${x}" y="${y + h}" font-size="${Math.max(6, 10 * scale)}" fill="#475569">${safe.slice(0, 8)}</text>`)
    }
  }
  return (
    <svg viewBox="0 0 200 112" className="h-28 w-full rounded bg-[var(--color-surface)]">
      <g dangerouslySetInnerHTML={{ __html: parts.join('') }} />
    </svg>
  )
}
