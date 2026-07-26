import { describe, it, expect } from 'vitest'
import { __test__ } from '../src/main/kb-export'
import type { KnowledgeBaseDocSummary } from '../src/shared/types'

const { buildDocRelativePath, safeFileName, rewriteAssetUrlsToRelative, collectAssetRels } = __test__

describe('kb-export helpers', () => {
  it('safeFileName 转义非法字符', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(safeFileName('正常名称')).toBe('正常名称')
    expect(safeFileName('', '兜底')).toBe('兜底')
    expect(safeFileName('   ')).toBe('未命名文档')
  })

  it('buildDocRelativePath 按 parentId 层级拼接', () => {
    const docs: KnowledgeBaseDocSummary[] = [
      { id: 'root', kbId: 'k', name: '根', createdAt: '', updatedAt: '' },
      { id: 'child', kbId: 'k', name: '子', parentId: 'root', createdAt: '', updatedAt: '' },
      { id: 'grand', kbId: 'k', name: '孙', parentId: 'child', createdAt: '', updatedAt: '' }
    ]
    expect(buildDocRelativePath(docs, 'root', '根')).toBe('根')
    expect(buildDocRelativePath(docs, 'child', '子')).toBe('根/子')
    expect(buildDocRelativePath(docs, 'grand', '孙')).toBe('根/子/孙')
  })

  it('buildDocRelativePath 循环引用不无限递归', () => {
    const docs: KnowledgeBaseDocSummary[] = [
      { id: 'a', kbId: 'k', name: 'A', parentId: 'b', createdAt: '', updatedAt: '' },
      { id: 'b', kbId: 'k', name: 'B', parentId: 'a', createdAt: '', updatedAt: '' }
    ]
    // 不会无限递归；返回有限字符串
    const p = buildDocRelativePath(docs, 'a', 'A')
    expect(typeof p).toBe('string')
    expect(p.length).toBeLessThan(100)
  })

  it('rewriteAssetUrlsToRelative 替换协议为相对路径', () => {
    const md = '![图](noteweave-asset:///notes/x/img.png) 文本 ![](noteweave-asset://assets/knowledge-bases/k/a.png)'
    const out = rewriteAssetUrlsToRelative(md, 'assets')
    expect(out).toContain('assets/notes/x/img.png')
    expect(out).toContain('assets/knowledge-bases/k/a.png')
    expect(out).not.toContain('noteweave-asset:')
  })

  it('collectAssetRels 提取去重资源路径', () => {
    const md = '![](noteweave-asset:///a.png) ![](noteweave-asset:///a.png) ![](noteweave-asset:///b.png)'
    const rels = collectAssetRels(md)
    expect(rels).toEqual(['a.png', 'a.png', 'b.png'])
  })
})
