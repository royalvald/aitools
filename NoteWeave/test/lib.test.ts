import { describe, it, expect } from 'vitest'
import {
  findAll,
  replaceAll,
  replaceInRange,
  buildRegExp,
  findNext,
  findPrev
} from '../src/renderer/src/lib/find-replace'
import { countStats, formatMain } from '../src/renderer/src/lib/word-count'
import { parseFrontMatter, stripFrontMatter, buildFrontMatter, getTags, syncTagsToFrontMatter } from '../src/shared/front-matter'
import { fuzzyMatch } from '../src/renderer/src/lib/fuzzy'

describe('find-replace', () => {
  it('findAll 普通字符串', () => {
    const r = findAll('hello world hello', 'hello', { caseSensitive: false, wholeWord: false, regex: false })
    expect(r.length).toBe(2)
    expect(r[0]).toEqual({ start: 0, end: 5 })
  })

  it('findAll 正则', () => {
    const r = findAll('a1 b2 c3', /\d/, { caseSensitive: false, wholeWord: false, regex: true })
    expect(r.length).toBe(3)
  })

  it('findAll 区分大小写', () => {
    const r = findAll('Hello hello', 'Hello', { caseSensitive: true, wholeWord: false, regex: false })
    expect(r.length).toBe(1)
  })

  it('replaceAll 替换全部', () => {
    const { text, count } = replaceAll('foo bar foo', 'foo', 'X', { caseSensitive: false, wholeWord: false, regex: false })
    expect(text).toBe('X bar X')
    expect(count).toBe(2)
  })

  it('replaceInRange 按区间替换', () => {
    const ranges = findAll('aXa X', 'X', { caseSensitive: false, wholeWord: false, regex: false })
    const { text } = replaceInRange('aXa X', ranges, 'Y')
    expect(text).toBe('aYa Y')
  })

  it('buildRegExp 无效正则返回 null', () => {
    expect(buildRegExp('(', { caseSensitive: false, wholeWord: false, regex: true })).toBeNull()
  })

  it('findNext 回环', () => {
    const ranges = findAll('aa', 'a', { caseSensitive: false, wholeWord: false, regex: false })
    expect(ranges.length).toBe(2)
    const n = findNext(ranges, 2)
    expect(n?.start).toBe(0) // 回环
  })

  it('findPrev 回环', () => {
    const ranges = findAll('aa', 'a', { caseSensitive: false, wholeWord: false, regex: false })
    const p = findPrev(ranges, 0)
    expect(p?.start).toBe(1)
  })
})

describe('word-count', () => {
  it('中文按字符计数', () => {
    const s = countStats('你好世界')
    expect(s.cjkChars).toBe(4)
    expect(s.words).toBe(4)
  })

  it('英文按单词计数', () => {
    const s = countStats('hello world')
    expect(s.words).toBe(2)
  })

  it('中英混合', () => {
    const s = countStats('你好 hello 世界 world')
    expect(s.cjkChars).toBe(4)
    expect(s.words).toBe(6) // 4 中文 + 2 英文单词
  })

  it('字符数含/不含空格', () => {
    const s = countStats('a b c')
    expect(s.chars).toBe(5)
    expect(s.charsNoSpace).toBe(3)
  })

  it('段落数', () => {
    const s = countStats('第一段\n\n第二段\n\n第三段')
    expect(s.paragraphs).toBe(3)
  })

  it('formatMain 三种模式', () => {
    const s = countStats('你好')
    expect(formatMain(s, 'words')).toBe('2 字')
    expect(formatMain(s, 'chars')).toBe('2 字符')
  })
})

describe('front-matter', () => {
  it('解析 front matter', () => {
    const r = parseFrontMatter('---\ntitle: 标题\ntags: [a, b]\n---\n正文')
    expect(r.frontMatter).not.toBeNull()
    expect(r.frontMatter!.title).toBe('标题')
    expect(r.body).toBe('正文')
    expect(getTags(r.frontMatter)).toEqual(['a', 'b'])
  })

  it('无 front matter', () => {
    const r = parseFrontMatter('普通正文')
    expect(r.frontMatter).toBeNull()
    expect(r.body).toBe('普通正文')
  })

  it('stripFrontMatter', () => {
    expect(stripFrontMatter('---\nx: 1\n---\n正文')).toBe('正文')
  })

  it('buildFrontMatter 往返', () => {
    const fm = { title: 'T', tags: ['a', 'b'] }
    const md = buildFrontMatter(fm, '正文')
    expect(md.startsWith('---\n')).toBe(true)
    const parsed = parseFrontMatter(md)
    expect(parsed.frontMatter!.title).toBe('T')
    expect(getTags(parsed.frontMatter)).toEqual(['a', 'b'])
    expect(parsed.body).toBe('正文')
  })
})

describe('fuzzy', () => {
  it('子序列匹配', () => {
    expect(fuzzyMatch('abc', 'aXbXc')).toBeGreaterThan(0)
  })
  it('不匹配返回 0', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBe(0)
  })
  it('空查询命中', () => {
    expect(fuzzyMatch('', 'anything')).toBeGreaterThan(0)
  })
})

describe('front-matter tags sync', () => {
  it('syncTagsToFrontMatter: 无 front matter 时新建', () => {
    const md = syncTagsToFrontMatter('正文', ['a', 'b'])
    expect(md.startsWith('---\n')).toBe(true)
    const parsed = parseFrontMatter(md)
    expect(getTags(parsed.frontMatter)).toEqual(['a', 'b'])
    expect(parsed.body).toBe('正文')
  })

  it('syncTagsToFrontMatter: 已有 front matter 时更新 tags 保留其它字段', () => {
    const md = syncTagsToFrontMatter('---\ntitle: T\ntags: [old]\ndate: 2026\n---\n正文', ['new1', 'new2'])
    const parsed = parseFrontMatter(md)
    expect(parsed.frontMatter!.title).toBe('T')
    expect(parsed.frontMatter!.date).toBe(2026)
    expect(getTags(parsed.frontMatter)).toEqual(['new1', 'new2'])
  })

  it('syncTagsToFrontMatter: tags 为空时移除 tags 字段', () => {
    const md = syncTagsToFrontMatter('---\ntitle: T\ntags: [a]\n---\n正文', [])
    const parsed = parseFrontMatter(md)
    expect(parsed.frontMatter!.title).toBe('T')
    expect(parsed.frontMatter!.tags).toBeUndefined()
  })
})
