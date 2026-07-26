import { useCallback, useState } from 'react'
import { buildPrompt, type AiPromptInput } from '../../../shared/ai-prompts'
import { useSettings } from './useSettings'

// REQ-215 本地 AI（Ollama）调用 hook。
// 复用 settings.ollama 配置；若未启用返回错误。
export function useAi() {
  const { settings } = useSettings()
  const [loading, setLoading] = useState(false)

  const runAction = useCallback(
    async (input: AiPromptInput): Promise<{ ok: boolean; text?: string; error?: string }> => {
      if (!settings.ollama?.enabled) {
        return { ok: false, error: 'AI 未启用，请在设置中开启 Ollama 并配置模型' }
      }
      setLoading(true)
      try {
        const prompt = buildPrompt(input)
        const r = await window.electronAPI.ollamaGenerate(settings.ollama.model || '', prompt)
        return r
      } finally {
        setLoading(false)
      }
    },
    [settings.ollama]
  )

  // 原始 generate（自定义 prompt），供白板 AI / 标签推荐复用
  const generate = useCallback(
    async (prompt: string): Promise<{ ok: boolean; text?: string; error?: string }> => {
      if (!settings.ollama?.enabled) {
        return { ok: false, error: 'AI 未启用' }
      }
      setLoading(true)
      try {
        return await window.electronAPI.ollamaGenerate(settings.ollama.model || '', prompt)
      } finally {
        setLoading(false)
      }
    },
    [settings.ollama]
  )

  const enabled = !!settings.ollama?.enabled

  return { runAction, generate, loading, enabled }
}
