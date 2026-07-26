// YAML Front Matter 解析与构造（REQ-103）。
// 不引入完整 YAML 解析依赖，仅实现子集：键值对、行内数组/逗号列表、引号字符串。
// 满足 NoteWeave 常用字段（title / tags / date / categories / author 等）。
// 注意：与 src/shared/front-matter.ts 保持逻辑一致（渲染进程无法直接 import 主进程侧的 shared 运行时模块）。

export interface FrontMatter {
  [key: string]: string | string[] | number | boolean | null
}

export interface ParsedFrontMatter {
  frontMatter: FrontMatter | null
  body: string
  raw: string // 含 --- 围栏的原始文本（用于原样保留 / Markdown 导出）
}

const FENCE_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function parseFrontMatter(content: string): ParsedFrontMatter {
  if (typeof content !== 'string' || content.length === 0) {
    return { frontMatter: null, body: content ?? '', raw: '' }
  }
  if (!content.startsWith('---')) {
    return { frontMatter: null, body: content, raw: '' }
  }
  const m = content.match(FENCE_RE)
  if (!m) {
    return { frontMatter: null, body: content, raw: '' }
  }
  const raw = m[0]
  const yamlBlock = m[1]
  const body = content.slice(raw.length)
  return { frontMatter: parseYaml(yamlBlock), body, raw }
}

export function stripFrontMatter(content: string): string {
  return parseFrontMatter(content).body
}

export function parseYaml(yaml: string): FrontMatter {
  const result: FrontMatter = {}
  const lines = yaml.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (!key) continue
    result[key] = parseScalar(value)
  }
  return result
}

function parseScalar(raw: string): string | string[] | number | boolean | null {
  const v = raw.trim()
  if (v === '') return ''
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((s) => unquote(s.trim()))
  }
  if (v.includes(',') && !isQuoted(v)) {
    return v.split(',').map((s) => unquote(s.trim())).filter((s) => s.length > 0)
  }
  return parsePrimitive(unquote(v))
}

function isQuoted(v: string): boolean {
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
}

function unquote(v: string): string {
  if (v.length >= 2 && isQuoted(v)) return v.slice(1, -1)
  return v
}

function parsePrimitive(v: string): string | number | boolean | null {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
  return v
}

export function stringifyYaml(fm: FrontMatter): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`)
      } else {
        lines.push(`${key}: [${value.map(quoteIfNeed).join(', ')}]`)
      }
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${quoteIfNeed(value)}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  return lines.join('\n')
}

function quoteIfNeed(s: string): string {
  if (s === '') return '""'
  if (/[:#\[\]{}&'*!|>%@`,]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}

export function buildFrontMatter(frontMatter: FrontMatter, body: string): string {
  const yaml = stringifyYaml(frontMatter)
  if (!yaml) return body
  return `---\n${yaml}\n---\n${body}`
}

export function getTags(fm: FrontMatter | null): string[] {
  if (!fm) return []
  const tags = fm.tags
  if (Array.isArray(tags)) return tags.map((t) => String(t))
  if (typeof tags === 'string') {
    return tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * REQ-103：把新的标签集合写回文档 front matter，实现 tags 与现有标签系统双向同步。
 * - 若文档已有 front matter：更新其 tags 字段（保留其它字段），返回新全文。
 * - 若文档无 front matter 但提供了新标签：在顶部新建一个 front matter 块。
 * - 若新标签为空且 front matter 已存在：移除 tags 字段；若 front matter 由此变空则整体移除。
 */
export function syncTagsToFrontMatter(content: string, tags: string[]): string {
  const parsed = parseFrontMatter(content)
  if (!parsed.frontMatter) {
    if (tags.length === 0) return content
    const fm: FrontMatter = { tags }
    return buildFrontMatter(fm, content)
  }
  const fm: FrontMatter = { ...parsed.frontMatter }
  if (tags.length > 0) {
    fm.tags = tags
  } else {
    delete fm.tags
  }
  const yaml = stringifyYaml(fm)
  if (!yaml) {
    // front matter 变空：整体移除
    return parsed.body
  }
  return `---\n${yaml}\n---\n${parsed.body}`
}
