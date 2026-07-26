// REQ-102 字数 / 字符统计纯函数。
// 中文按字符计数，英文按单词计数（与 Typora 口径一致）。

export interface CountStats {
  chars: number // 含空格的字符数
  charsNoSpace: number // 不含空白
  words: number // 中文按字符 + 英文按单词 的合计（"字数"）
  cjkChars: number
  paragraphs: number
  readMinutes: number // 阅读时间估算（分钟）
}

export type CountMode = 'words' | 'chars' | 'readMinutes'

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/g

/** 统计纯文本的字数 / 字符 / 段落 / 阅读时间。 */
export function countStats(text: string): CountStats {
  if (!text) {
    return { chars: 0, charsNoSpace: 0, words: 0, cjkChars: 0, paragraphs: 0, readMinutes: 0 }
  }
  const chars = text.length
  const charsNoSpace = text.replace(/\s/g, '').length
  const cjkMatch = text.match(CJK_RE)
  const cjkChars = cjkMatch ? cjkMatch.length : 0
  // 英文单词数：去掉中文/标点后的连续拉丁字母数字串
  const nonCjk = text.replace(CJK_RE, ' ')
  const latinWords = (nonCjk.match(/[A-Za-z0-9]+/g) || []).length
  const words = cjkChars + latinWords
  // 段落：以空行或换行分隔的非空块
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0).length
  // 阅读时间：中文 ~400 字/分，英文 ~200 词/分，取加权
  const cjkMin = cjkChars / 400
  const latinMin = latinWords / 200
  const readMinutes = Math.max(words > 0 ? 1 : 0, Math.ceil(cjkMin + latinMin))
  return { chars, charsNoSpace, words, cjkChars, paragraphs, readMinutes }
}

/** 格式化状态栏主显示文本。 */
export function formatMain(stats: CountStats, mode: CountMode): string {
  switch (mode) {
    case 'chars':
      return `${stats.chars} 字符`
    case 'readMinutes':
      return `${stats.readMinutes} 分钟`
    case 'words':
    default:
      return `${stats.words} 字`
  }
}
