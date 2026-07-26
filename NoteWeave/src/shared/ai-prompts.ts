// REQ-215 本地 AI（Ollama）提示词构造纯函数。
// 所有提示词为中文指令模板，便于单测。

export type AiAction = 'continue' | 'summarize' | 'translate' | 'explain' | 'qa'

export interface AiPromptInput {
  action: AiAction
  text: string // 选中文本或正文
  /** 翻译目标语言（translate 用，如「英文」「中文」） */
  targetLang?: string
  /** 问答问题（qa 用，可与 text 一起作为上下文） */
  question?: string
}

export function buildPrompt(input: AiPromptInput): string {
  const t = input.text.trim()
  switch (input.action) {
    case 'continue':
      return `请续写以下内容，保持风格与语气一致，直接输出续写后的文本（不要复述原文）：\n\n${t}`
    case 'summarize':
      return `请用简洁的中文总结以下内容的要点（不超过 200 字，用无序列表）：\n\n${t}`
    case 'translate':
      return `请把以下内容翻译为${input.targetLang ?? '英文'}，只输出译文，不要解释：\n\n${t}`
    case 'explain':
      return `请用通俗的中文解释以下内容，必要时举例：\n\n${t}`
    case 'qa':
      return `基于以下内容回答问题。若内容中没有答案，请说明。\n\n问题：${input.question ?? ''}\n\n内容：\n${t}`
  }
}

// 用于自动标签（REQ-217 复用）：从文本中提取候选关键词
export function buildTagPrompt(text: string, existingTags: string[]): string {
  const t = text.trim().slice(0, 2000)
  const ex = existingTags.slice(0, 50).join('、')
  return `请从以下文本中提取 3 个最相关的标签（中文，简洁）。\n优先复用已有标签集合：${ex || '（无）'}\n只输出逗号分隔的标签，不要其它说明。\n\n文本：\n${t}`
}

// 解析标签模型输出为标签数组
export function parseTagsOutput(output: string, max = 3): string[] {
  const parts = output
    .split(/[，,、\n]/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, '').replace(/[#""']/g, ''))
    .filter((s) => s.length > 0 && s.length <= 20)
  return parts.slice(0, max)
}
