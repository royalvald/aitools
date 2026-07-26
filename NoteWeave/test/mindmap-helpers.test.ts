import { describe, it, expect } from 'vitest'
import {
  defaultMindmapData,
  makeNode,
  mindmapFromMarkdown,
  mindmapToOpml,
  findNode,
  updateNode,
  removeNode
} from '../src/shared/mindmap-helpers'

describe('mindmap-helpers', () => {
  it('defaultMindmapData 含根 + 3 子', () => {
    const d = defaultMindmapData()
    expect(d.root.text).toBe('中心主题')
    expect(d.root.children.length).toBe(3)
  })

  it('mindmapFromMarkdown 按标题层级构建', () => {
    const md = '# 根\n## 子 A\n### 孙\n## 子 B\n'
    const d = mindmapFromMarkdown(md)
    // 只有一个一级标题 → 提升为根
    expect(d.root.text).toBe('根')
    expect(d.root.children.length).toBe(2)
    expect(d.root.children[0].text).toBe('子 A')
    expect(d.root.children[0].children[0].text).toBe('孙')
    expect(d.root.children[1].text).toBe('子 B')
  })

  it('mindmapFromMarkdown 多个一级标题归到虚拟根', () => {
    const md = '# A\n# B\n'
    const d = mindmapFromMarkdown(md)
    expect(d.root.children.length).toBe(2)
  })

  it('mindmapFromMarkdown 非标题行作为叶子', () => {
    const md = '# 根\n普通文字\n## 子\n'
    const d = mindmapFromMarkdown(md)
    expect(d.root.text).toBe('根')
    expect(d.root.children.some((c) => c.text === '普通文字')).toBe(true)
  })

  it('mindmapToOpml 生成合法 OPML', () => {
    const d = { root: makeNode('根', [makeNode('子1'), makeNode('子2', [makeNode('孙')])]) }
    const opml = mindmapToOpml(d, '测试')
    expect(opml).toContain('<?xml')
    expect(opml).toContain('<opml version="2.0">')
    expect(opml).toContain('<title>测试</title>')
    expect(opml).toContain('text="根"')
    expect(opml).toContain('text="子1"')
    expect(opml).toContain('text="孙"')
  })

  it('mindmapToOpml 转义 XML 特殊字符', () => {
    const d = { root: makeNode('a<b>"c"&d') }
    const opml = mindmapToOpml(d)
    expect(opml).toContain('&lt;')
    expect(opml).toContain('&quot;')
    expect(opml).toContain('&amp;')
    expect(opml).not.toContain('<b>"')
  })

  it('findNode 找到节点与父节点', () => {
    const child = makeNode('子')
    const root = makeNode('根', [child])
    const r = findNode(root, child.id)
    expect(r?.node.id).toBe(child.id)
    expect(r?.parent?.id).toBe(root.id)
  })

  it('updateNode 不可变更新指定节点', () => {
    const child = makeNode('子')
    const root = makeNode('根', [child])
    const next = updateNode(root, child.id, (n) => ({ ...n, text: '改名' }))
    expect(next.children[0].text).toBe('改名')
    expect(root.children[0].text).toBe('子') // 原 root 未变
  })

  it('removeNode 删除非根节点', () => {
    const a = makeNode('a')
    const b = makeNode('b')
    const root = makeNode('根', [a, b])
    const next = removeNode(root, a.id)
    expect(next.children.length).toBe(1)
    expect(next.children[0].id).toBe(b.id)
  })
})
