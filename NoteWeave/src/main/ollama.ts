import { net } from 'electron'

// REQ-215 Ollama 本地 AI 客户端（通过 net.fetch 调用 Ollama HTTP API）。
// 文档：https://github.com/ollama/ollama/blob/main/docs/api.md

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

// 列出可用模型
export async function ollamaListModels(
  url: string
): Promise<{ ok: boolean; models?: string[]; error?: string }> {
  const base = normalizeUrl(url)
  try {
    const resp = await net.fetch(`${base}/api/tags`)
    if (!resp.ok) {
      return { ok: false, error: `Ollama 返回 ${resp.status}` }
    }
    const data = (await resp.json()) as { models?: { name: string }[] }
    const models = (data.models ?? []).map((m) => m.name)
    return { ok: true, models }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// 生成（非流式）
export async function ollamaGenerate(
  url: string,
  model: string,
  prompt: string,
  options?: { temperature?: number }
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const base = normalizeUrl(url)
  try {
    const body = {
      model,
      prompt,
      stream: false,
      options: options?.temperature !== undefined ? { temperature: options.temperature } : undefined
    }
    const resp = await net.fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!resp.ok) {
      return { ok: false, error: `Ollama 返回 ${resp.status}` }
    }
    const data = (await resp.json()) as { response?: string; error?: string }
    if (data.error) {
      return { ok: false, error: data.error }
    }
    return { ok: true, text: data.response ?? '' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
