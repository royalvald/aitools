// REQ-101 文档内查找替换的纯函数。
// findAll 在文本中返回所有匹配区间；replaceInRange 按区间（从后往前）替换。

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface MatchRange {
  start: number
  end: number // exclusive
}

/** 构造正则；无效正则返回 null（调用方提示用户）。 */
export function buildRegExp(query: string, opts: FindOptions): RegExp | null {
  if (!query) return null
  let source = query
  let flags = 'g'
  if (!opts.caseSensitive) flags += 'i'
  if (opts.regex) {
    try {
      return new RegExp(source, flags)
    } catch {
      return null
    }
  }
  // 普通字符串：转义元字符
  source = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) {
    // 用 \b 切词；中文无词边界，wholeWord 对中文无副作用
    source = `\\b${source}\\b`
  }
  return new RegExp(source, flags)
}

/** 在文本中查找全部匹配，返回按 start 升序的区间。 */
export function findAll(text: string, query: string, opts: FindOptions): MatchRange[] {
  if (!text) return []
  const re = buildRegExp(query, opts)
  if (!re) return []
  const ranges: MatchRange[] = []
  let m: RegExpExecArray | null
  // 重置 lastIndex 防御复用
  re.lastIndex = 0
  let guard = 0
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      // 零宽匹配：前进一格避免死循环
      re.lastIndex += 1
      continue
    }
    ranges.push({ start: m.index, end: m.index + m[0].length })
    guard++
    if (guard > 100000) break
  }
  return ranges
}

/** 在文本中按指定区间替换（从后往前，避免偏移漂移）。返回新文本与替换次数。 */
export function replaceInRange(
  text: string,
  ranges: MatchRange[],
  replacement: string
): { text: string; count: number } {
  if (ranges.length === 0) return { text, count: 0 }
  // 仅替换非重叠区间：先按 start 排序，过滤重叠
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const valid: MatchRange[] = []
  let lastEnd = -1
  for (const r of sorted) {
    if (r.start >= lastEnd) {
      valid.push(r)
      lastEnd = r.end
    }
  }
  let out = text
  for (const r of valid.reverse()) {
    out = out.slice(0, r.start) + replacement + out.slice(r.end)
  }
  return { text: out, count: valid.length }
}

/** 全部替换：直接对每个匹配替换。 */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions
): { text: string; count: number } {
  const ranges = findAll(text, query, opts)
  return replaceInRange(text, ranges, replacement)
}

/** 给定当前光标位置，找下一个匹配（从 from 开始；到末尾则回环）。 */
export function findNext(
  ranges: MatchRange[],
  from: number
): MatchRange | null {
  if (ranges.length === 0) return null
  const next = ranges.find((r) => r.start >= from)
  if (next) return next
  return ranges[0] // 回环到第一个
}

/** 给定当前光标位置，找上一个匹配。 */
export function findPrev(
  ranges: MatchRange[],
  from: number
): MatchRange | null {
  if (ranges.length === 0) return null
  let prev: MatchRange | null = null
  for (const r of ranges) {
    if (r.start < from) prev = r
    else break
  }
  if (prev) return prev
  return ranges[ranges.length - 1] // 回环到最后一个
}
