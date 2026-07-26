// REQ-230 白板 AI 提示词构造纯函数。

// 选中便签内容生成总结/聚类
export function buildSummarizePrompt(stickyTexts: string[]): string {
  const list = stickyTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  return `以下是白板上的便签内容，请用中文生成主题聚类与总结：\n${list}\n\n请输出：\n1. 概括这些便签的核心主题（1-2 句）\n2. 按主题归类的要点（无序列表）\n3. 建议的下一步行动（1-3 条）`
}

// 生成记录摘要 + 行动项（用于整体总结）
export function buildRecordSummaryPrompt(stickyTexts: string[]): string {
  const list = stickyTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  return `基于以下白板便签，生成一份会议/思考记录摘要：\n${list}\n\n请输出 Markdown：\n## 摘要\n（2-3 句）\n## 行动项\n- [ ] ...`
}

// 根据提示词生成白板初稿（输出 JSON 元素描述）
export function buildDraftPrompt(userPrompt: string): string {
  return `根据以下描述，设计一个白板初稿。输出严格的 JSON 数组（不要 markdown 代码块），每个元素形如 {"type":"sticky","text":"内容","color":"#fef9c3|#dcfce7|#dbeafe|#fce7f3"} 或 {"type":"text","text":"标题"}。最多 8 个元素。\n\n描述：${userPrompt}`
}

// 解析初稿 JSON 输出为元素描述数组（容错）
export interface DraftElement {
  type: 'sticky' | 'text'
  text: string
  color?: string
}

export function parseDraftOutput(output: string): DraftElement[] {
  // 去掉可能的 markdown 代码块包裹
  let cleaned = output.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  // 提取第一个 [ 到最后一个 ]
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown[]
    const out: DraftElement[] = []
    for (const item of arr) {
      if (item && typeof item === 'object') {
        const obj = item as { type?: string; text?: string; color?: string }
        if ((obj.type === 'sticky' || obj.type === 'text') && typeof obj.text === 'string') {
          out.push({ type: obj.type, text: obj.text.slice(0, 200), color: obj.color })
        }
      }
    }
    return out.slice(0, 12)
  } catch {
    return []
  }
}
