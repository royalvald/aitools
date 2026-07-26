import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type {
  AnchorName,
  BaseWhiteboardElement,
  WhiteboardContentCard,
  WhiteboardElement,
  WhiteboardConnector,
  WhiteboardShape,
  WhiteboardStickyNote,
  WhiteboardText
} from '../types'
import {
  connectorEndpoints,
  connectorPath,
  resizeHandlePos,
  resizeRect,
  RESIZE_ANCHORS,
  RESIZE_CURSORS,
  type ResizeAnchor
} from '../lib/whiteboard-canvas'
import { cn } from '../lib/utils'

// REQ-222 单个白板元素的渲染与交互（拖拽移动、拖拽控制点改变大小、双击编辑文本、删除）。
// 所有坐标均为画布世界坐标（像素），由父级通过 transform: scale 渲染。
interface ElementViewProps {
  element: WhiteboardElement
  allElements: WhiteboardElement[]
  selected: boolean
  /** 为 false 时为仅浏览：不可选中/拖动/编辑/右键菜单，内容卡片保留点击打开 */
  interactive?: boolean
  scale: number
  editing: boolean
  onSelect: (id: string, additive: boolean) => void
  onChange: (id: string, patch: Partial<WhiteboardElement>) => void
  onStartEdit: (id: string) => void
  onEndEdit: () => void
  onDelete: (id: string) => void
  onStartConnect: (fromId: string, anchor: AnchorName) => void
  pendingConnectFrom: { elementId: string; anchor: AnchorName } | null
  onFinishConnect: (toId: string, anchor: AnchorName) => void
  /** REQ-222 置顶/置底（需要全局 zIndex 上下文，由父级计算） */
  onReorder?: (id: string, direction: 'front' | 'back') => void
  /** REQ-221 拖拽对齐辅助线 */
  onDragStart?: (id: string) => void
  onDragMove?: (id: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragEnd?: (id: string) => void
  /** REQ-223 点击内容卡片跳转 */
  onOpenContentCard?: (card: WhiteboardContentCard) => void
  /** REQ-226 便签/文本转为待办（行动项） */
  onConvertToTodo?: (text: string) => void
  /** REQ-229 便签/文本插入到关联文档（转为段落） */
  onInsertToDoc?: (text: string) => void
}

const ANCHORS: AnchorName[] = ['top', 'right', 'bottom', 'left']
const HANDLE_SIZE = 8 // 控制点尺寸（屏幕像素）

export function WhiteboardElementView(props: ElementViewProps) {
  const { element, selected, scale, editing } = props
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  if (element.type === 'connector') {
    return <ConnectorView {...props} connector={element} />
  }

  const base = element as BaseWhiteboardElement
  // 拖拽中
  const dragState = useRef<{
    mode: 'move' | 'resize'
    anchor?: ResizeAnchor
    startWorld: { x: number; y: number }
    origin: { x: number; y: number; width: number; height: number }
  } | null>(null)
  const [localEditing, setLocalEditing] = useState(false)

  useEffect(() => {
    setLocalEditing(editing)
  }, [editing])

  const toWorld = (clientX: number, clientY: number) => {
    // 通过 props.scale 与父级 transform 反推世界坐标；
    // 父级 transformOrigin 为 top-left，offset 已包含在父容器定位中，
    // 因此这里需要把客户端坐标减去画布视口原点。父级在 pointer 事件里已提供相对坐标，
    // 此处接收的参数即为「相对画布内容层左上角」的屏幕像素。
    return { x: clientX / scale, y: clientY / scale }
  }

  const handlePointerDown = (e: React.PointerEvent, mode: 'move' | 'resize', anchor?: ResizeAnchor) => {
    if (e.button !== 0) return
    // 仅浏览：内容卡片阻止冒泡以保留点击打开（避免触发画布平移的指针捕获），
    // 其余元素不拦截，事件冒泡到画布作为平移起点
    if (props.interactive === false) {
      if (element.type === 'content') e.stopPropagation()
      return
    }
    if (base.locked && mode === 'move') return
    e.stopPropagation()
    props.onSelect(base.id, e.ctrlKey || e.metaKey || e.shiftKey)
    // 用画布内容层左上角作为基准；这里用 closest 找到 canvas-world
    const layer = (e.currentTarget as HTMLElement).closest('[data-canvas-world]') as HTMLElement | null
    const layerRect = layer?.getBoundingClientRect()
    const sx = layerRect ? e.clientX - layerRect.left : e.clientX
    const sy = layerRect ? e.clientY - layerRect.top : e.clientY
    const startWorld = toWorld(sx, sy)
    dragState.current = {
      mode,
      anchor,
      startWorld,
      origin: { x: base.x, y: base.y, width: base.width, height: base.height }
    }
    if (mode === 'move' || mode === 'resize') {
      props.onDragStart?.(base.id)
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const ds = dragState.current
    if (!ds) return
    const layer = (e.currentTarget as HTMLElement).closest('[data-canvas-world]') as HTMLElement | null
    const layerRect = layer?.getBoundingClientRect()
    const sx = layerRect ? e.clientX - layerRect.left : e.clientX
    const sy = layerRect ? e.clientY - layerRect.top : e.clientY
    const world = toWorld(sx, sy)
    const dx = world.x - ds.startWorld.x
    const dy = world.y - ds.startWorld.y
    if (ds.mode === 'move') {
      const next = {
        x: Math.round(ds.origin.x + dx),
        y: Math.round(ds.origin.y + dy)
      }
      props.onChange(base.id, next as Partial<WhiteboardElement>)
      props.onDragMove?.(base.id, { x: next.x, y: next.y, width: base.width, height: base.height })
    } else if (ds.mode === 'resize' && ds.anchor) {
      // Shift 等比缩放；左/上锚点锚定对侧（见 resizeRect）
      const next = resizeRect(ds.origin, ds.anchor, dx, dy, e.shiftKey)
      props.onChange(base.id, next as Partial<WhiteboardElement>)
      props.onDragMove?.(base.id, next)
    }
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    dragState.current = null
    props.onDragEnd?.(base.id)
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const handleDoubleClick = () => {
    if (props.interactive === false) return
    if (element.type === 'sticky' || element.type === 'text') {
      props.onStartEdit(base.id)
      setLocalEditing(true)
    }
  }

  const commitText = (text: string) => {
    props.onChange(base.id, { text } as Partial<WhiteboardElement>)
    props.onEndEdit()
    setLocalEditing(false)
  }

  // 渲染元素本体
  const renderBody = () => {
    if (element.type === 'sticky') {
      const s = element as WhiteboardStickyNote
      return (
        <div
          className="h-full w-full overflow-hidden p-3"
          style={{ background: s.color, fontSize: (s.fontSize ?? 14) * 1 }}
        >
          {localEditing ? (
            <AutoGrowTextarea
              value={s.text}
              onCommit={commitText}
              scale={scale}
              fontSize={s.fontSize ?? 14}
            />
          ) : (
            // 便签为浅色卡片，显示态与编辑态（AutoGrowTextarea）统一固定深色文字
            <div className="whitespace-pre-wrap break-words text-[#1e293b]">{s.text}</div>
          )}
        </div>
      )
    }
    if (element.type === 'text') {
      const t = element as WhiteboardText
      return (
        <div className="h-full w-full p-1">
          {localEditing ? (
            <AutoGrowTextarea
              value={t.text}
              onCommit={commitText}
              scale={scale}
              fontSize={t.fontSize ?? 16}
            />
          ) : (
            <div
              className="whitespace-pre-wrap break-words"
              style={{ fontSize: t.fontSize ?? 16, color: t.color ?? '#1e293b' }}
            >
              {t.text}
            </div>
          )}
        </div>
      )
    }
    if (element.type === 'shape') {
      const sh = element as WhiteboardShape
      return <ShapeSvg shape={sh} />
    }
    if (element.type === 'content') {
      const c = element as WhiteboardContentCard
      return (
        <div
          className="flex h-full w-full cursor-pointer flex-col gap-1 overflow-hidden border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          onClick={(e) => {
            e.stopPropagation()
            if (!c.invalid) props.onOpenContentCard?.(c)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (!c.invalid) props.onOpenContentCard?.(c)
          }}
        >
          <div className="flex items-center gap-1 text-xs text-[var(--color-muted-foreground)]">
            <span className="rounded bg-[var(--color-muted)] px-1">
              {c.targetKind === 'note' ? '笔记' : c.targetKind === 'kbDoc' ? '文档' : c.targetKind === 'image' ? '图片' : c.targetKind === 'attachment' ? '附件' : '网页'}
            </span>
            {c.invalid && <span className="text-[var(--color-danger)]">已失效</span>}
          </div>
          {c.targetKind === 'image' && c.url && (
            <div className="flex-1 overflow-hidden rounded bg-[var(--color-surface-2)]">
              <img src={c.url} alt={c.title} className="h-full w-full object-cover" />
            </div>
          )}
          <div className={cn('truncate text-sm font-medium', c.invalid ? 'text-[var(--color-muted-foreground)] line-through' : 'text-[var(--color-foreground)]')}>
            {c.title || '未命名'}
          </div>
          {c.summary && <div className="line-clamp-3 text-xs text-[var(--color-muted-foreground)]">{c.summary}</div>}
        </div>
      )
    }
    return null
  }

  const handleSizeScreen = HANDLE_SIZE / scale

  return (
    <div
      data-element-id={base.id}
      onPointerDown={(e) => handlePointerDown(e, 'move')}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (props.interactive === false) return
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      className={cn(
        'absolute select-none',
        base.locked || props.interactive === false ? 'cursor-default' : 'cursor-move',
        element.type === 'shape' && element.shape !== 'rect' ? '' : ''
      )}
      style={{
        left: base.x,
        top: base.y,
        width: base.width,
        height: base.height,
        zIndex: base.zIndex,
        outline: selected ? '2px solid var(--color-accent)' : undefined,
        borderRadius: element.type === 'shape' && (element as WhiteboardShape).shape === 'rounded-rect' ? 12 : undefined
      }}
    >
      {renderBody()}

      {/* REQ-226 优先级标记徽标 */}
      {base.priority && (
        <span
          className={cn(
            'absolute -top-2 left-1 rounded px-1 py-0.5 text-[10px] font-bold',
            PRIORITY_STYLES[base.priority].badge
          )}
          style={{ zIndex: base.zIndex + 2 }}
        >
          {PRIORITY_STYLES[base.priority].label.split(' ')[0]}
        </span>
      )}

      {/* REQ-221 成组指示徽标 */}
      {base.groupId && (
        <span
          className="absolute -top-2 right-1 rounded bg-[var(--color-primary)] px-1 py-0.5 text-[10px] font-bold text-[var(--color-primary-foreground)]"
          style={{ zIndex: base.zIndex + 2 }}
          title="已分组（Ctrl+Shift+G 解组）"
        >
          组
        </span>
      )}

      {/* 锚点：用于开始/结束连线（仅选中时显示）；向外偏移避免与缩放手柄重叠 */}
      {selected && !base.locked && (
        <>
          {ANCHORS.map((a) => {
            const pos = anchorScreenPos(base, a)
            const off = handleSizeScreen * 1.5
            const ox = a === 'left' ? -off : a === 'right' ? off : 0
            const oy = a === 'top' ? -off : a === 'bottom' ? off : 0
            return (
              <button
                key={a}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  props.onStartConnect(base.id, a)
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  // 若已有 pending 连线起点，点击锚点完成连线（连到自身不同锚点）
                  if (props.pendingConnectFrom && props.pendingConnectFrom.elementId !== base.id) {
                    props.onFinishConnect(base.id, a)
                  }
                }}
                className="absolute rounded-full border border-[var(--color-accent)] bg-[var(--color-surface)] hover:bg-[var(--color-accent-soft)]"
                style={{
                  width: handleSizeScreen,
                  height: handleSizeScreen,
                  left: pos.x + ox - handleSizeScreen / 2,
                  top: pos.y + oy - handleSizeScreen / 2,
                  zIndex: base.zIndex + 1
                }}
                title={`连线锚点 (${a})`}
              />
            )
          })}
          {/* 调整大小控制点：4 角 + 4 边中点（Shift 等比缩放） */}
          {RESIZE_ANCHORS.map((a) => {
            const pos = resizeHandlePos(base, a)
            return (
              <div
                key={a}
                onPointerDown={(e) => handlePointerDown(e, 'resize', a)}
                className="absolute"
                style={{
                  left: pos.x - handleSizeScreen / 2,
                  top: pos.y - handleSizeScreen / 2,
                  width: handleSizeScreen,
                  height: handleSizeScreen,
                  background: 'var(--color-accent)',
                  borderRadius: 2,
                  cursor: RESIZE_CURSORS[a],
                  zIndex: base.zIndex + 1
                }}
              />
            )
          })}
          {/* 删除按钮 */}
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              props.onDelete(base.id)
            }}
            className="absolute -top-3 -right-3 rounded-full bg-[var(--color-danger)] p-0.5 text-[var(--color-primary-foreground)] shadow hover:bg-[var(--color-danger)]"
            style={{ zIndex: base.zIndex + 2 }}
            title="删除"
          >
            <Trash2 style={{ width: 12 / scale + 8, height: 12 / scale + 8 }} />
          </button>
        </>
      )}

      {/* REQ-222 右键菜单：层级 / 锁定 / 删除 / 颜色 */}
      {menu && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null) }} />
          <div
            className="fixed z-[9999] w-40 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-1 text-sm shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem label="置顶" onClick={() => { props.onReorder?.(base.id, 'front'); setMenu(null) }} />
            <MenuItem label="置底" onClick={() => { props.onReorder?.(base.id, 'back'); setMenu(null) }} />
            <MenuItem
              label={base.locked ? '解锁' : '锁定'}
              onClick={() => { props.onChange(base.id, { locked: !base.locked } as Partial<WhiteboardElement>); setMenu(null) }}
            />
            {base.groupId && (
              <MenuItem
                label="解组"
                onClick={() => {
                  const { groupId: _groupId, ...rest } = base
                  props.onChange(base.id, rest as Partial<WhiteboardElement>)
                  setMenu(null)
                }}
              />
            )}
            {/* REQ-226 优先级标记 */}
            <div className="divider my-1" />
            <div className="px-3 py-1 text-xs text-[var(--color-muted-foreground)]">优先级</div>
            <div className="flex items-center gap-1 px-3 py-1">
              {(['high', 'medium', 'low'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    props.onChange(base.id, { priority: p } as Partial<WhiteboardElement>)
                    setMenu(null)
                  }}
                  className={cn(
                    'rounded px-2 py-0.5 text-[11px] font-medium',
                    base.priority === p ? PRIORITY_STYLES[p].active : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-border-strong)]'
                  )}
                >
                  {PRIORITY_STYLES[p].label}
                </button>
              ))}
              <button
                onClick={() => {
                  props.onChange(base.id, { priority: undefined } as Partial<WhiteboardElement>)
                  setMenu(null)
                }}
                className="ml-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
                title="清除优先级"
              >
                清除
              </button>
            </div>
            {element.type === 'sticky' && (
              <>
                <div className="divider my-1" />
                <div className="px-3 py-1 text-xs text-[var(--color-muted-foreground)]">便签颜色</div>
                <div className="flex gap-1 px-3 py-1">
                  {STICKY_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => {
                        props.onChange(base.id, { color: c } as Partial<WhiteboardElement>)
                        setMenu(null)
                      }}
                      className="h-4 w-4 rounded border border-[var(--color-border)]"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </>
            )}
            {(element.type === 'sticky' || element.type === 'text') && props.onConvertToTodo && (
              <>
                <div className="divider my-1" />
                <MenuItem
                  label="转为待办（行动项）"
                  onClick={() => {
                    const text = (element as { text?: string }).text ?? ''
                    props.onConvertToTodo?.(text)
                    setMenu(null)
                  }}
                />
              </>
            )}
            {(element.type === 'sticky' || element.type === 'text') && props.onInsertToDoc && (
              <MenuItem
                label="插入到关联文档"
                onClick={() => {
                  const text = (element as { text?: string }).text ?? ''
                  props.onInsertToDoc?.(text)
                  setMenu(null)
                }}
              />
            )}
            <div className="divider my-1" />
            <MenuItem label="删除" danger onClick={() => { props.onDelete(base.id); setMenu(null) }} />
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1 text-left hover:bg-[var(--color-muted)]',
        danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-foreground)]'
      )}
    >
      {label}
    </button>
  )
}

const STICKY_COLORS = ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#ede9fe', '#fee2e2']

const PRIORITY_STYLES: Record<
  'high' | 'medium' | 'low',
  { label: string; active: string; badge: string }
> = {
  high: { label: 'P0 高', active: 'bg-[var(--color-danger)] text-[var(--color-primary-foreground)]', badge: 'bg-[var(--color-danger)] text-[var(--color-primary-foreground)]' },
  medium: { label: 'P1 中', active: 'bg-[var(--color-warning)] text-[var(--color-primary-foreground)]', badge: 'bg-[var(--color-warning)] text-[var(--color-primary-foreground)]' },
  low: { label: 'P2 低', active: 'bg-[var(--color-border-strong)] text-[var(--color-primary-foreground)]', badge: 'bg-[var(--color-border-strong)] text-[var(--color-primary-foreground)]' }
}

// 锚点在元素本地坐标系（相对元素左上角，世界像素）中的位置
function anchorScreenPos(base: BaseWhiteboardElement, anchor: AnchorName): { x: number; y: number } {
  switch (anchor) {
    case 'top':
      return { x: base.width / 2, y: 0 }
    case 'right':
      return { x: base.width, y: base.height / 2 }
    case 'bottom':
      return { x: base.width / 2, y: base.height }
    case 'left':
      return { x: 0, y: base.height / 2 }
  }
}

// 形状的 SVG 渲染（rect/rounded-rect/circle/diamond/arrow）
function ShapeSvg({ shape }: { shape: WhiteboardShape }) {
  const { width, height, shape: kind, fill, stroke, strokeWidth } = shape
  const sw = strokeWidth ?? 2
  const common = {
    fill: fill ?? '#fff',
    stroke: stroke ?? '#475569',
    strokeWidth: sw
  }
  if (kind === 'circle') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <ellipse cx={width / 2} cy={height / 2} rx={width / 2 - sw} ry={height / 2 - sw} {...common} />
      </svg>
    )
  }
  if (kind === 'diamond') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polygon points={`${width / 2},${sw} ${width - sw},${height / 2} ${width / 2},${height - sw} ${sw},${height / 2}`} {...common} />
      </svg>
    )
  }
  if (kind === 'arrow') {
    return (
      <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <marker id={`arrow-${shape.id}`} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 Z" fill={stroke ?? '#475569'} />
          </marker>
        </defs>
        <line
          x1={sw}
          y1={height / 2}
          x2={width - sw}
          y2={height / 2}
          stroke={stroke ?? '#475569'}
          strokeWidth={sw}
          markerEnd={`url(#arrow-${shape.id})`}
        />
      </svg>
    )
  }
  // rect / rounded-rect
  return (
    <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <rect
        x={sw}
        y={sw}
        width={width - sw * 2}
        height={height - sw * 2}
        rx={kind === 'rounded-rect' ? 12 : 0}
        {...common}
      />
    </svg>
  )
}

// 自动撑高的多行文本编辑（双击便签/文本进入编辑）
function AutoGrowTextarea({
  value,
  onCommit,
  scale,
  fontSize
}: {
  value: string
  onCommit: (text: string) => void
  scale: number
  fontSize: number
}) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCommit(text)
        }
      }}
      className="h-full w-full resize-none bg-transparent outline-none"
      style={{ fontSize, color: '#1e293b' }}
    />
  )
}

// 连线渲染：根据起止元素锚点实时计算路径
function ConnectorView({
  connector,
  allElements,
  selected,
  interactive,
  onSelect,
  onChange,
  onDelete
}: ElementViewProps & { connector: WhiteboardConnector }) {
  const { from, to } = connectorEndpoints(connector, allElements)
  const d = connectorPath(connector, from, to)
  const [editingLabel, setEditingLabel] = useState(false)
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2

  const commitLabel = (text: string) => {
    setEditingLabel(false)
    const next = text.trim() || undefined
    if (next !== connector.label) {
      onChange(connector.id, { label: next } as Partial<WhiteboardElement>)
    }
  }

  return (
    <g
      onPointerDown={(e) => {
        // 仅浏览：不拦截，事件冒泡到画布作为平移起点
        if (interactive === false) return
        e.stopPropagation()
        onSelect(connector.id, e.ctrlKey || e.metaKey || e.shiftKey)
      }}
      onDoubleClick={(e) => {
        if (interactive === false) return
        e.stopPropagation()
        setEditingLabel(true)
      }}
      style={{ cursor: interactive === false ? 'default' : 'pointer' }}
    >
      {/* 透明粗线作为命中区 */}
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} />
      <path
        d={d}
        fill="none"
        stroke={connector.color ?? '#475569'}
        strokeWidth={connector.strokeWidth ?? 2}
        markerEnd={connector.arrowEnd ? 'url(#wb-arrow-end)' : undefined}
        markerStart={connector.arrowStart ? 'url(#wb-arrow-start)' : undefined}
      />
      {/* 连线标签 */}
      {(connector.label || editingLabel) && (
        <foreignObject x={midX - 60} y={midY - 14} width={120} height={28}>
          {editingLabel ? (
            <input
              autoFocus
              defaultValue={connector.label ?? ''}
              onBlur={(e) => commitLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLabel((e.target as HTMLInputElement).value)
                if (e.key === 'Escape') setEditingLabel(false)
              }}
              className="input h-full w-full px-1 py-0.5 text-center text-xs"
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <span className="rounded-md bg-[var(--color-surface)] px-2 py-0.5 text-xs font-medium text-[var(--color-foreground)] shadow-sm">
                {connector.label}
              </span>
            </div>
          )}
        </foreignObject>
      )}
      {selected && (
        <g>
          <circle cx={from.x} cy={from.y} r={5} fill="var(--color-accent)" />
          <circle cx={to.x} cy={to.y} r={5} fill="var(--color-accent)" />
          <foreignObject x={to.x + 6} y={to.y - 24} width={20} height={20}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(connector.id)
              }}
              className="flex h-full w-full items-center justify-center rounded-full bg-[var(--color-danger)] text-[var(--color-primary-foreground)]"
              title="删除连线"
            >
              <Trash2 width={12} height={12} />
            </button>
          </foreignObject>
        </g>
      )}
    </g>
  )
}
