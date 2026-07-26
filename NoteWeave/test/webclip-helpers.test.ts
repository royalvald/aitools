import { describe, it, expect } from 'vitest'
import { buildBookmarklet } from '../src/shared/webclip-helpers'
import { matchRoute, parseClipPayload } from '../src/shared/http-api-helpers'

describe('webclip bookmarklet', () => {
  it('生成 javascript: 开头的 bookmarklet', () => {
    const bl = buildBookmarklet('http://127.0.0.1:1234', 'tok')
    expect(bl.startsWith('javascript:')).toBe(true)
  })
  it('包含 endpoint 与 token', () => {
    const bl = buildBookmarklet('http://127.0.0.1:1234/', 'abc123')
    const decoded = decodeURIComponent(bl.replace(/^javascript:/, ''))
    expect(decoded).toContain('http://127.0.0.1:1234/api/clip')
    expect(decoded).toContain('abc123')
  })
  it('baseUrl 尾部斜杠被规范化', () => {
    const bl = buildBookmarklet('http://127.0.0.1:1234///', 't')
    const decoded = decodeURIComponent(bl.replace(/^javascript:/, ''))
    expect(decoded).toContain('http://127.0.0.1:1234/api/clip')
    expect(decoded).not.toContain('1234///api')
  })
})

describe('http-api clip route + payload', () => {
  it('matchRoute /api/clip', () => {
    expect(matchRoute('/api/clip')).toEqual({ kind: 'clip' })
  })
  it('parseClipPayload 合法 JSON', () => {
    const p = parseClipPayload(JSON.stringify({ title: '标题', url: 'https://a.com', content: '正文' }))
    expect(p?.title).toBe('标题')
    expect(p?.url).toBe('https://a.com')
    expect(p?.content).toBe('正文')
  })
  it('parseClipPayload 缺 url 返回 null', () => {
    expect(parseClipPayload(JSON.stringify({ title: 'x' }))).toBeNull()
  })
  it('parseClipPayload 非 JSON 返回 null', () => {
    expect(parseClipPayload('not json')).toBeNull()
  })
  it('parseClipPayload 标题过长被截断', () => {
    const long = 'a'.repeat(300)
    const p = parseClipPayload(JSON.stringify({ title: long, url: 'u' }))
    expect(p?.title.length).toBe(200)
  })
})
