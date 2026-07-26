import { describe, it, expect } from 'vitest'
import {
  safeDocName,
  stripNotionUuid,
  extractNotionImageNames,
  htmlFallbackToText,
  isImportableExt
} from '../src/shared/import-converters'

describe('import-converters', () => {
  it('safeDocName 去扩展名 + 处理路径', () => {
    expect(safeDocName('报告.docx')).toBe('报告')
    expect(safeDocName('a/b/c/notes.md')).toBe('notes')
    expect(safeDocName('noext')).toBe('noext')
    expect(safeDocName('  .hidden')).toBe('未命名文档')
  })

  it('stripNotionUuid 去末尾 32 位 UUID', () => {
    expect(stripNotionUuid('我的文档 abc123def4567890123456789012abcd')).toBe('我的文档')
    expect(stripNotionUuid('普通标题')).toBe('普通标题')
  })

  it('extractNotionImageNames 提取图片文件名（URL 解码）', () => {
    const md = '![a](image%201.png) text ![b](sub/x%20y.jpg)'
    expect(extractNotionImageNames(md)).toEqual(['image 1.png', 'x y.jpg'])
  })

  it('htmlFallbackToText 去标签保留段落', () => {
    const html = '<h1>标题</h1><p>第一段</p><p>第二段</p>'
    const text = htmlFallbackToText(html)
    expect(text).toContain('标题')
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
    expect(text).not.toContain('<')
  })

  it('isImportableExt 识别可导入扩展名', () => {
    expect(isImportableExt('.docx')).toBe(true)
    expect(isImportableExt('html')).toBe(true)
    expect(isImportableExt('.MD')).toBe(true)
    expect(isImportableExt('.pdf')).toBe(false)
    expect(isImportableExt('.zip')).toBe(false)
  })
})
