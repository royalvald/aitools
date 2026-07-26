import type { MindmapData, MindmapNode } from './types'

// REQ-212 思维导图纯函数：节点 id 生成、Markdown 标题解析、OPML 序列化、节点查找/遍历。

export function newMindmapId(): string {
  return `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export function makeNode(text: string, children: MindmapNode[] = []): MindmapNode {
  return { id: newMindmapId(), text, children }
}

// 默认思维导图：根节点 + 3 个子节点
export function defaultMindmapData(): MindmapData {
  return {
    root: makeNode('中心主题', [
      makeNode('分支 1'),
      makeNode('分支 2'),
      makeNode('分支 3')
    ])
  }
}

// 从 Markdown 标题层级（# ~ ######）构建思维导图。
// 非标题行作为最近一个父标题的子节点（叶子）。
export function mindmapFromMarkdown(markdown: string): MindmapData {
  const lines = markdown.split('\n')
  const root = makeNode('主题')
  // 用栈维护当前层级的节点路径：stack[level] = 该层级的节点
  const stack: { level: number; node: MindmapNode }[] = [{ level: 0, node: root }]
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      const level = m[1].length
      const text = m[2].trim()
      const node = makeNode(text)
      // 弹栈直到父节点 level < 当前 level
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      const parent = stack[stack.length - 1].node
      parent.children.push(node)
      stack.push({ level, node })
    } else {
      // 非标题：作为当前栈顶节点的子节点
      const parent = stack[stack.length - 1].node
      parent.children.push(makeNode(line))
    }
  }
  // 若根没有子节点，退化为中心主题
  if (root.children.length === 0) {
    root.text = markdown.slice(0, 30) || '主题'
  } else if (root.children.length === 1) {
    // 只有一个一级标题时，把它提升为根
    return { root: root.children[0] }
  }
  return { root }
}

// OPML 序列化：标准 OPML 2.0
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function nodeToOpml(node: MindmapNode, indent: number): string {
  const pad = '  '.repeat(indent)
  const text = escapeXml(node.text)
  if (node.children.length === 0) {
    return `${pad}<outline text="${text}"/>\n`
  }
  let out = `${pad}<outline text="${text}">\n`
  for (const c of node.children) {
    out += nodeToOpml(c, indent + 1)
  }
  out += `${pad}</outline>\n`
  return out
}

export function mindmapToOpml(data: MindmapData, title = '思维导图'): string {
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXml(
    title
  )}</title>\n  </head>\n  <body>\n`
  const body = nodeToOpml(data.root, 2)
  return header + body + `  </body>\n</opml>\n`
}

// 深拷贝节点树（生成新 id 可选；默认保留 id）
export function cloneNode(node: MindmapNode, newIds = false): MindmapNode {
  return {
    id: newIds ? newMindmapId() : node.id,
    text: node.text,
    collapsed: node.collapsed,
    children: node.children.map((c) => cloneNode(c, newIds))
  }
}

// 在树中按 id 查找节点及其父节点
export function findNode(
  root: MindmapNode,
  id: string
): { node: MindmapNode; parent: MindmapNode | null } | null {
  if (root.id === id) return { node: root, parent: null }
  const walk = (parent: MindmapNode): { node: MindmapNode; parent: MindmapNode } | null => {
    for (const c of parent.children) {
      if (c.id === id) return { node: c, parent }
      const found = walk(c)
      if (found) return found
    }
    return null
  }
  return walk(root)
}

// 不可变更新：在树中对某节点应用 updater
export function updateNode(
  root: MindmapNode,
  id: string,
  updater: (n: MindmapNode) => MindmapNode
): MindmapNode {
  if (root.id === id) return updater({ ...root })
  return { ...root, children: root.children.map((c) => updateNode(c, id, updater)) }
}

// 删除节点（返回新树；根节点不可删）
export function removeNode(root: MindmapNode, id: string): MindmapNode {
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => removeNode(c, id))
  }
}
