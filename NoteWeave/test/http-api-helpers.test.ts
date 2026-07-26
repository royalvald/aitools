import { describe, it, expect } from 'vitest'
import { matchRoute, tokenMatches } from '../src/shared/http-api-helpers'

describe('http-api matchRoute', () => {
  it('/api/help', () => {
    expect(matchRoute('/api/help')).toEqual({ kind: 'help' })
  })
  it('/api/kbs', () => {
    expect(matchRoute('/api/kbs')).toEqual({ kind: 'kbs' })
  })
  it('/api/kbs/:kbId/docs', () => {
    expect(matchRoute('/api/kbs/abc/docs')).toEqual({ kind: 'kbDocs', kbId: 'abc' })
  })
  it('/api/docs/:kbId/:docId', () => {
    expect(matchRoute('/api/docs/k1/d1')).toEqual({ kind: 'doc', kbId: 'k1', docId: 'd1' })
  })
  it('/api/search', () => {
    expect(matchRoute('/api/search')).toEqual({ kind: 'search', q: '', type: undefined })
  })
  it('未知路径 → notFound', () => {
    expect(matchRoute('/api/unknown')).toEqual({ kind: 'notFound', path: '/api/unknown' })
    expect(matchRoute('/other')).toEqual({ kind: 'notFound', path: '/other' })
  })
  it('尾部斜杠被规范化', () => {
    expect(matchRoute('/api/kbs/')).toEqual({ kind: 'kbs' })
  })
  it('kbId 含特殊字符被解码', () => {
    expect(matchRoute('/api/kbs/%E4%B8%AD%E6%96%87/docs')).toEqual({ kind: 'kbDocs', kbId: '中文' })
  })
})

describe('http-api tokenMatches', () => {
  const expected = 'secret123'
  it('Bearer token 匹配', () => {
    expect(tokenMatches('Bearer secret123', null, expected)).toBe(true)
    expect(tokenMatches('Bearer wrong', null, expected)).toBe(false)
  })
  it('query token 匹配', () => {
    expect(tokenMatches(undefined, 'secret123', expected)).toBe(true)
    expect(tokenMatches(undefined, 'wrong', expected)).toBe(false)
  })
  it('两者皆空不通过', () => {
    expect(tokenMatches(undefined, null, expected)).toBe(false)
  })
  it('Bearer 优先于 query', () => {
    // Bearer 错误但 query 正确 → 仍 false（Bearer 提供时必须对）
    expect(tokenMatches('Bearer wrong', 'secret123', expected)).toBe(false)
  })
})
