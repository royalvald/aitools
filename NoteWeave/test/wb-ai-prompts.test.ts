import { describe, it, expect } from 'vitest'
import {
  buildSummarizePrompt,
  buildRecordSummaryPrompt,
  buildDraftPrompt,
  parseDraftOutput
} from '../src/shared/wb-ai-prompts'

describe('wb-ai-prompts build', () => {
  it('summarize 含编号便签 + 输出要求', () => {
    const p = buildSummarizePrompt(['想法 A', '想法 B'])
    expect(p).toContain('1. 想法 A')
    expect(p).toContain('2. 想法 B')
    expect(p).toContain('主题')
    expect(p).toContain('行动')
  })
  it('record 含便签 + Markdown 行动项', () => {
    const p = buildRecordSummaryPrompt(['x'])
    expect(p).toContain('1. x')
    expect(p).toContain('## 摘要')
    expect(p).toContain('## 行动项')
    expect(p).toContain('- [ ]')
  })
  it('draft 含用户描述 + JSON 格式要求', () => {
    const p = buildDraftPrompt('项目启动')
    expect(p).toContain('项目启动')
    expect(p).toContain('JSON')
    expect(p).toContain('"type":"sticky"')
  })
})

describe('wb-ai-prompts parseDraftOutput', () => {
  it('解析合法 JSON 数组', () => {
    const out = parseDraftOutput('[{"type":"sticky","text":"A","color":"#fef9c3"},{"type":"text","text":"标题"}]')
    expect(out.length).toBe(2)
    expect(out[0].type).toBe('sticky')
    expect(out[1].type).toBe('text')
  })
  it('剥离 markdown 代码块', () => {
    const out = parseDraftOutput('```json\n[{"type":"sticky","text":"B"}]\n```')
    expect(out.length).toBe(1)
    expect(out[0].text).toBe('B')
  })
  it('提取文本中嵌入的数组', () => {
    const out = parseDraftOutput('结果如下：[{"type":"sticky","text":"C"}] 完成')
    expect(out.length).toBe(1)
    expect(out[0].text).toBe('C')
  })
  it('无效/无数组返回空', () => {
    expect(parseDraftOutput('不是 JSON')).toEqual([])
    expect(parseDraftOutput('[]')).toEqual([])
  })
  it('过滤非法 type', () => {
    const out = parseDraftOutput('[{"type":"shape","text":"x"},{"type":"sticky","text":"y"}]')
    expect(out.length).toBe(1)
    expect(out[0].text).toBe('y')
  })
  it('限制最多 12 个', () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ type: 'sticky', text: String(i) }))
    expect(parseDraftOutput(JSON.stringify(arr)).length).toBe(12)
  })
})
