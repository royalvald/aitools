import { describe, it, expect } from 'vitest'
import { BUILTIN_WB_TEMPLATES } from '../src/shared/wb-templates'

describe('wb-templates', () => {
  it('内置至少 6 种模板', () => {
    expect(BUILTIN_WB_TEMPLATES.length).toBeGreaterThanOrEqual(6)
  })

  it('每个模板有 id/name/elements', () => {
    for (const t of BUILTIN_WB_TEMPLATES) {
      expect(typeof t.id).toBe('string')
      expect(typeof t.name).toBe('string')
      expect(Array.isArray(t.elements)).toBe(true)
      expect(t.builtin).toBe(true)
    }
  })

  it('模板 id 唯一', () => {
    const ids = BUILTIN_WB_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('空白模板元素为空', () => {
    const blank = BUILTIN_WB_TEMPLATES.find((t) => t.id === 'wb-blank')
    expect(blank?.elements.length).toBe(0)
  })

  it('非空模板含便签/文本/形状元素', () => {
    const brainstorm = BUILTIN_WB_TEMPLATES.find((t) => t.id === 'wb-brainstorm')
    expect(brainstorm).toBeTruthy()
    const types = brainstorm!.elements.map((e) => (e as { type: string }).type)
    expect(types).toContain('sticky')
  })

  it('SWOT 模板含 4 个象限便签', () => {
    const swot = BUILTIN_WB_TEMPLATES.find((t) => t.id === 'wb-swot')
    expect(swot!.elements.filter((e) => (e as { type: string }).type === 'sticky').length).toBe(4)
  })
})
