import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, FileInput, Plus, Save, Trash2 } from 'lucide-react'
import type { KnowledgeBaseDoc, MindmapData, MindmapNode } from '../types'
import {
  makeNode,
  updateNode,
  removeNode
} from '../../../shared/mindmap-helpers'
import { Modal } from './Modal'

// REQ-212 思维导图编辑器：水平树状布局，节点可编辑/折叠/增删，从 Markdown 标题生成，导出 OPML/PNG。
interface MindmapEditorProps {
  doc: KnowledgeBaseDoc
}

interface PositionedNode {
  node: MindmapNode
  x: number
  y: number
  width: number
  depth: number
}

const NODE_H = 36
const NODE_W = 140
const H_GAP = 80
const V_GAP = 12

// 计算可见节点布局（水平树）。返回节点位置 + 整体尺寸。
function layout(root?: MindmapNode): { nodes: PositionedNode[]; width: number; height: number } {
  if (!root) return { nodes: [], width: 0, height: 0 }
  const nodes: PositionedNode[] = []
  // 先计算每个子树的可见叶子数（决定占用高度）
  function leafCount(n: MindmapNode): number {
    if (n.collapsed || n.children.length === 0) return 1
    return n.children.reduce((s, c) => s + leafCount(c), 0)
  }
  let cursor = 0
  function walk(n: MindmapNode, depth: number) {
    const leaves = leafCount(n)
    const myY = cursor + (leaves * (NODE_H + V_GAP)) / 2
    const startX = depth * (NODE_W + H_GAP)
    nodes.push({ node: n, x: startX, y: myY, width: NODE_W, depth })
    if (!n.collapsed) {
      for (const c of n.children) {
        walk(c, depth + 1)
      }
    } else {
      // 折叠时不递归，cursor 仍只占自身
    }
    cursor += leaves * (NODE_H + V_GAP)
  }
  walk(root, 0)
  const width = (maxDepth(root) + 1) * (NODE_W + H_GAP)
  const height = Math.max(cursor, NODE_H + V_GAP)
  return { nodes, width, height: height + V_GAP }
}

function maxDepth(n: MindmapNode): number {
  if (n.children.length === 0) return 0
  return 1 + Math.max(...n.children.map(maxDepth))
}

export function MindmapEditor({ doc }: MindmapEditorProps) {
  const [data, setData] = useState<MindmapData | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [showMdImport, setShowMdImport] = useState(false)
  const [mdText, setMdText] = useState('')
  const dirtyRef = useRef(false)

  useEffect(() => {
    setLoading(true)
    window.electronAPI.getMindmapDoc(doc.kbId, doc.id).then((d) => {
      setData(d ?? { root: makeNode('中心主题') })
      setLoading(false)
      dirtyRef.current = false
    })
  }, [doc.kbId, doc.id])

  // 防抖自动保存
  useEffect(() => {
    if (!data || !dirtyRef.current) return
    const t = setTimeout(() => {
      void doSave(data)
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const doSave = async (d: MindmapData) => {
    setSaving(true)
    await window.electronAPI.saveMindmapDoc(doc.kbId, doc.id, d)
    setSaving(false)
    setSavedFlash(true)
    dirtyRef.current = false
    setTimeout(() => setSavedFlash(false), 1200)
  }

  // 注意：所有 Hook 必须在任何条件 return 之前调用，否则 React 会抛出
  // "Rendered more hooks than during the previous render" 导致整棵树白屏。
  const layoutInfo = useMemo(() => layout(data?.root), [data])
  const svgRef = useRef<SVGSVGElement>(null)
  const nodeById = useMemo(() => {
    const m = new Map<string, PositionedNode>()
    for (const pn of layoutInfo.nodes) m.set(pn.node.id, pn)
    return m
  }, [layoutInfo])

  if (loading || !data) {
    return <div className="flex h-full items-center justify-center text-[var(--color-muted-foreground)]">加载思维导图…</div>
  }

  const update = (updater: (root: MindmapNode) => MindmapNode) => {
    setData((prev) => {
      if (!prev) return prev
      dirtyRef.current = true
      return { root: updater(prev.root) }
    })
  }

  const startEdit = (id: string, text: string) => {
    setEditingId(id)
    setEditText(text)
  }
  const commitEdit = () => {
    if (editingId) {
      const text = editText.trim() || '未命名'
      update((root) => updateNode(root, editingId, (n) => ({ ...n, text })))
    }
    setEditingId(null)
  }

  const addChild = (parentId: string) => {
    update((root) =>
      updateNode(root, parentId, (n) => ({
        ...n,
        collapsed: false,
        children: [...n.children, makeNode('新节点')]
      }))
    )
  }
  const delNode = (id: string) => {
    if (id === data.root.id) return // 根不可删
    update((root) => removeNode(root, id))
  }
  const toggleCollapse = (id: string) => {
    update((root) => updateNode(root, id, (n) => ({ ...n, collapsed: !n.collapsed })))
  }

  const handleImportMd = async () => {
    if (!mdText.trim()) {
      setShowMdImport(false)
      return
    }
    await window.electronAPI.mindmapFromMarkdown(doc.kbId, doc.id, mdText)
    const fresh = await window.electronAPI.getMindmapDoc(doc.kbId, doc.id)
    if (fresh) setData(fresh)
    setShowMdImport(false)
    setMdText('')
  }

  // 导出 OPML（主进程落盘）
  const handleExportOpml = async () => {
    await window.electronAPI.exportMindmapDoc(doc.kbId, doc.id, 'opml')
  }
  // 导出 PNG：把布局 SVG 序列化为 dataURL，主进程写盘
  const handleExportPng = async () => {
    const svgEl = svgRef.current
    if (!svgEl) return
    const xml = new XMLSerializer().serializeToString(svgEl)
    const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(svgBlob)
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = layoutInfo.width + 40
      canvas.height = layoutInfo.height + 40
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 20, 20)
      URL.revokeObjectURL(url)
      const dataUrl = canvas.toDataURL('image/png')
      await window.electronAPI.exportMindmapDoc(doc.kbId, doc.id, 'png', dataUrl)
    }
    img.src = url
  }

  // 连线：父节点右侧 → 子节点左侧（贝塞尔）
  const links: { from: PositionedNode; to: PositionedNode }[] = []
  for (const pn of layoutInfo.nodes) {
    if (pn.node.collapsed) continue
    for (const c of pn.node.children) {
      const cp = nodeById.get(c.id)
      if (cp) links.push({ from: pn, to: cp })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-6 py-2">
        <button onClick={() => addChild(data.root.id)} className="btn-ghost">
          <Plus className="h-4 w-4" />
          添加子节点
        </button>
        <button onClick={() => doSave(data)} disabled={saving} className="btn-primary">
          <Save className="h-4 w-4" />
          保存
        </button>
        <div className="divider h-5 w-px" />
        <button onClick={() => setShowMdImport(true)} className="btn-ghost" title="从 Markdown 标题生成">
          <FileInput className="h-4 w-4" />
          从 Markdown 生成
        </button>
        <button onClick={handleExportOpml} className="btn-ghost" title="导出 OPML">
          <Download className="h-4 w-4" />
          OPML
        </button>
        <button onClick={handleExportPng} className="btn-ghost" title="导出 PNG">
          <Download className="h-4 w-4" />
          PNG
        </button>
        {savedFlash && <span className="text-xs text-[var(--color-success)]">已保存</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--color-surface-2)] p-4">
        <svg
          ref={svgRef}
          width={layoutInfo.width + 40}
          height={layoutInfo.height + 40}
          xmlns="http://www.w3.org/2000/svg"
          style={{ minWidth: '100%' }}
        >
          {/* 连线 */}
          {links.map((l, i) => {
            const x1 = l.from.x + l.from.width + 20
            const y1 = l.from.y + 20 + NODE_H / 2
            const x2 = l.to.x + 20
            const y2 = l.to.y + 20 + NODE_H / 2
            const mx = (x1 + x2) / 2
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="#94a3b8"
                strokeWidth={1.5}
              />
            )
          })}
          {/* 节点 */}
          {layoutInfo.nodes.map((pn) => {
            const isRoot = pn.node.id === data.root.id
            const collapsed = pn.node.collapsed && pn.node.children.length > 0
            return (
              <g key={pn.node.id} transform={`translate(${pn.x + 20}, ${pn.y + 20})`}>
                <rect
                  width={pn.width}
                  height={NODE_H}
                  rx={6}
                  fill={isRoot ? '#6366f1' : '#ffffff'}
                  stroke={isRoot ? '#6366f1' : '#cbd5e1'}
                  strokeWidth={1.5}
                />
                {editingId === pn.node.id ? (
                  <foreignObject x={4} y={4} width={pn.width - 8} height={NODE_H - 8}>
                    <input
                      autoFocus
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      style={{
                        width: '100%',
                        height: '100%',
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        textAlign: 'center',
                        fontSize: 13,
                        color: isRoot ? '#fff' : '#1e293b'
                      }}
                    />
                  </foreignObject>
                ) : (
                  <text
                    x={pn.width / 2}
                    y={NODE_H / 2 + 4}
                    textAnchor="middle"
                    fontSize={13}
                    fill={isRoot ? '#ffffff' : '#1e293b'}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onDoubleClick={() => startEdit(pn.node.id, pn.node.text)}
                  >
                    {pn.node.text.length > 14 ? pn.node.text.slice(0, 13) + '…' : pn.node.text}
                    {collapsed ? ' …' : ''}
                  </text>
                )}
                {/* 折叠/展开按钮 */}
                {pn.node.children.length > 0 && (
                  <g
                    transform={`translate(${pn.width - 14}, ${NODE_H / 2 - 8})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleCollapse(pn.node.id)}
                  >
                    <circle cx={8} cy={8} r={9} fill="#e2e8f0" />
                    {collapsed ? (
                      <ChevronRight x={3} y={3} width={10} height={10} stroke="#475569" />
                    ) : (
                      <ChevronDown x={3} y={3} width={10} height={10} stroke="#475569" />
                    )}
                  </g>
                )}
                {/* 操作按钮：+ 子节点 / 删除 */}
                <g
                  transform={`translate(${pn.width + 4}, 2)`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => addChild(pn.node.id)}
                >
                  <circle cx={9} cy={9} r={9} fill="#dbeafe" />
                  <text x={9} y={13} textAnchor="middle" fontSize={13} fill="#2563eb">
                    +
                  </text>
                </g>
                {!isRoot && (
                  <g
                    transform={`translate(${pn.width + 4}, ${NODE_H - 20})`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => delNode(pn.node.id)}
                  >
                    <circle cx={9} cy={9} r={9} fill="#fee2e2" />
                    <text x={9} y={13} textAnchor="middle" fontSize={11} fill="#dc2626">
                      ×
                    </text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="border-t border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-muted-foreground)]">
        双击节点编辑文本 · 点击节点旁 + 添加子节点 · × 删除节点 · 折叠按钮收起子树
      </div>

      {showMdImport && (
        <Modal title="从 Markdown 标题生成思维导图" onClose={() => setShowMdImport(false)}>
          <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
            粘贴 Markdown 文本，按标题层级（# ~ ######）生成节点树。非标题行作为最近父标题的叶子。
          </p>
          <textarea
            autoFocus
            value={mdText}
            onChange={(e) => setMdText(e.target.value)}
            rows={10}
            placeholder="# 主题&#10;## 分支 1&#10;### 子点&#10;## 分支 2"
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-primary)]"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowMdImport(false)} className="btn-secondary">
              取消
            </button>
            <button onClick={handleImportMd} className="btn-primary">
              生成（覆盖当前）
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
