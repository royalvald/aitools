import { describe, it, expect } from 'vitest'
import { buildPrompt, buildTagPrompt, parseTagsOutput, type AiAction } from '../src/shared/ai-prompts'

describe('ai-prompts buildPrompt', () => {
  const cases: { action: AiAction; expectContains: string }[] = [
    { action: 'continue', expectContains: '续写' },
    { action: 'summarize', expectContains: '总结' },
    { action: 'translate', expectContains: '翻译' },
    { action: 'explain', expectContains: '解释' },
    { action: 'qa', expectContains: '回答问题' }
  ]
  for (const c of cases) {
    it(`${c.action} 提示词含原文与指令`, () => {
      const p = buildPrompt({ action: c.action, text: '一段原文', targetLang: '英文', question: '为什么？' })
      expect(p).toContain('一段原文')
      expect(p).toContain(c.expectContains)
    })
  }
  it('translate 含目标语言', () => {
    const p = buildPrompt({ action: 'translate', text: 'x', targetLang: '日文' })
    expect(p).toContain('日文')
  })
  it('qa 含问题', () => {
    const p = buildPrompt({ action: 'qa', text: '上下文', question: '问题是？' })
    expect(p).toContain('问题是？')
    expect(p).toContain('上下文')
  })
})

describe('ai-prompts tags', () => {
  it('buildTagPrompt 含已有标签与文本', () => {
    const p = buildTagPrompt('某文本', ['架构', '设计'])
    expect(p).toContain('架构')
    expect(p).toContain('某文本')
  })
  it('parseTagsOutput 按中英文逗号/顿号/换行拆分', () => {
    expect(parseTagsOutput('架构,设计 测试\n实现')).toEqual(['架构', '设计 测试', '实现'])
    expect(parseTagsOutput('架构、设计，实现')).toEqual(['架构', '设计', '实现'])
  })
  it('parseTagsOutput 限制最多 3 个', () => {
    expect(parseTagsOutput('a,b,c,d,e').length).toBe(3)
  })
  it('parseTagsOutput 过滤空与过长', () => {
    expect(parseTagsOutput(',,a,这是一个非常非常长的标签超过二十个字符的标签,b')).toEqual(['a', 'b'])
  })
})
