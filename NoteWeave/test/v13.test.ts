import { describe, it, expect } from 'vitest'
import { parseMentions, buildMention, mentionsToReadable } from '../src/renderer/src/lib/mentions'
import { parseQuickSyntax } from '../src/renderer/src/lib/search-syntax'

describe('mentions', () => {
  it('parseMentions 解析 note 与 kbDoc 提及并去重', () => {
    const text = '参见 [[note:abc|标题A]] 和 [[kbDoc:def|文档D]] 以及 [[note:abc|标题A]]'
    const ms = parseMentions(text)
    expect(ms.length).toBe(2)
    expect(ms[0]).toEqual({ kind: 'note', id: 'abc', title: '标题A' })
    expect(ms[1]).toEqual({ kind: 'kbDoc', id: 'def', title: '文档D' })
  })

  it('parseMentions 空文本返回空数组', () => {
    expect(parseMentions('')).toEqual([])
    expect(parseMentions('没有提及的普通文本')).toEqual([])
  })

  it('buildMention 构造完整语法（含标题）', () => {
    expect(buildMention({ kind: 'note', id: 'x1', title: '标题' })).toBe('[[note:x1|标题]]')
  })

  it('buildMention 构造无标题提及', () => {
    expect(buildMention({ kind: 'kbDoc', id: 'x2' })).toBe('[[kbDoc:x2]]')
  })

  it('mentionsToReadable 替换为 @标题 形式', () => {
    expect(mentionsToReadable('参见 [[note:a|架构]]')).toBe('参见 @架构')
    expect(mentionsToReadable('[[kbDoc:b]]')).toBe('@kbDoc:b')
  })
})

describe('search-syntax parseQuickSyntax', () => {
  it('解析 tag: 与 kb: 与剩余关键词', () => {
    const r = parseQuickSyntax('架构 tag:设计 kb:kb1 文档')
    expect(r.keyword).toBe('架构 文档')
    expect(r.tags).toEqual(['设计'])
    expect(r.kbIds).toEqual(['kb1'])
    expect(r.forcedTypes).toEqual([])
  })

  it('解析 type: 快捷语法映射', () => {
    expect(parseQuickSyntax('关键词 type:doc').forcedTypes).toEqual(['kbDoc'])
    expect(parseQuickSyntax('type:comment').forcedTypes).toEqual(['comment'])
    expect(parseQuickSyntax('type:note').forcedTypes).toEqual(['note'])
  })

  it('未知 type 不产生强制类型', () => {
    expect(parseQuickSyntax('type:unknown').forcedTypes).toEqual([])
  })

  it('无快捷语法时返回纯关键词', () => {
    const r = parseQuickSyntax('普通关键词')
    expect(r.keyword).toBe('普通关键词')
    expect(r.tags).toEqual([])
    expect(r.kbIds).toEqual([])
    expect(r.forcedTypes).toEqual([])
  })
})
