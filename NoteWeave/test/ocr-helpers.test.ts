import { describe, it, expect } from 'vitest'
import { ocrCacheKey, relToAssetUrl, ocrTextMatches } from '../src/shared/ocr-helpers'

describe('ocr-helpers', () => {
  it('ocrCacheKey 去扩展名 + 规范化路径 + 截断', () => {
    expect(ocrCacheKey('notes/abc/img.png')).toBe('notes_abc_img')
    expect(ocrCacheKey('a\\b\\c.jpeg')).toBe('a_b_c')
    expect(ocrCacheKey('  spaces here.png')).toBe('_spaces_here')
  })

  it('ocrCacheKey 空路径兜底', () => {
    expect(ocrCacheKey('')).toBe('root')
    expect(ocrCacheKey('.png')).toBe('root')
  })

  it('ocrCacheKey 超长路径截断到 120 字符', () => {
    const long = 'a'.repeat(200) + '.png'
    const key = ocrCacheKey(long)
    expect(key.length).toBeLessThanOrEqual(120)
  })

  it('relToAssetUrl 生成协议 URL', () => {
    expect(relToAssetUrl('notes/x/y.png')).toBe('noteweave-asset:///notes/x/y.png')
    expect(relToAssetUrl('a\\b.png')).toBe('noteweave-asset:///a/b.png')
  })

  it('ocrTextMatches 不区分大小写', () => {
    expect(ocrTextMatches('Hello World 架构', 'world')).toBe(true)
    expect(ocrTextMatches('Hello World', 'WORLD')).toBe(true)
    expect(ocrTextMatches('Hello', 'xyz')).toBe(false)
    expect(ocrTextMatches('', 'x')).toBe(false)
    expect(ocrTextMatches('text', '')).toBe(false)
  })
})
