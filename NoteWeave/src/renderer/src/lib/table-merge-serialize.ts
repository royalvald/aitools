// REQ-105：合并单元格的 Markdown 往返序列化（纯函数，可单测）。
//
// 背景：Milkdown gfm 表格的 toMarkdown 只输出 GFM 表格语法（不支持 colspan/rowspan），
// 合并/拆分信息会在源码模式/导出时丢失。本模块提供：
// - tableToHtml：把「带合并信息的表格」序列化为原始 HTML <table>（保留 colspan/rowspan）。
// - htmlToTable：把 HTML <table> 解析回同样的网格结构。
// - isHtmlTable：判断一个 markdown 片段是否为 HTML 表格块。
//
// 数据结构 TableGrid 与单元格内容均为纯字符串（markdown 文本），独立于 ProseMirror schema，
// 便于往返测试。Milkdown 端在 schema 的 toMarkdown/parseMarkdown 中桥接到 ProseMirror 节点。

export interface GridCell {
  colspan: number
  rowspan: number
  /** 单元格内容（markdown 文本，已去除首尾空白） */
  content: string
  /** 是否表头单元格 */
  header: boolean
  /** 文本对齐（left/center/right） */
  align: 'left' | 'center' | 'right'
}

export interface TableGrid {
  rows: GridCell[][]
}

/** HTML 转义。 */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** HTML 反转义。 */
function unesc(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 判断表格是否含有合并单元格（colspan>1 或 rowspan>1）。 */
export function hasMergedCells(grid: TableGrid): boolean {
  return grid.rows.some((row) =>
    row.some((c) => c.colspan > 1 || c.rowspan > 1)
  )
}

/** 把 TableGrid 序列化为 HTML <table> 字符串（保留 colspan/rowspan/对齐/表头）。 */
export function tableToHtml(grid: TableGrid): string {
  const lines: string[] = ['<table>']
  for (const row of grid.rows) {
    lines.push('  <tr>')
    for (const cell of row) {
      const tag = cell.header ? 'th' : 'td'
      const attrs: string[] = []
      if (cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`)
      if (cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`)
      if (cell.align && cell.align !== 'left') {
        attrs.push(`style="text-align: ${cell.align}"`)
      }
      const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : ''
      lines.push(`    <${tag}${attrStr}>${esc(cell.content)}</${tag}>`)
    }
    lines.push('  </tr>')
  }
  lines.push('</table>')
  return lines.join('\n')
}

const TAG_RE = /^\s*<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1>\s*$/

/** 把 HTML <table> 字符串解析回 TableGrid。 */
export function htmlToTable(html: string): TableGrid | null {
  if (!/<table[\s>]/i.test(html)) return null
  const rows: GridCell[][] = []
  // 按行切分
  const rowMatches = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi)
  if (!rowMatches) return null
  for (const rowHtml of rowMatches) {
    const cells: GridCell[] = []
    const cellRe = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(rowHtml)) !== null) {
      const tag = cm[1].toLowerCase()
      const attrStr = cm[2] || ''
      const inner = cm[3] ?? ''
      const colspan = parseInt((attrStr.match(/colspan\s*=\s*"?(\d+)"?/i) || [])[1] || '1', 10) || 1
      const rowspan = parseInt((attrStr.match(/rowspan\s*=\s*"?(\d+)"?/i) || [])[1] || '1', 10) || 1
      const alignMatch = attrStr.match(/text-align\s*:\s*(left|center|right)/i)
      const align = (alignMatch ? alignMatch[1].toLowerCase() : 'left') as GridCell['align']
      cells.push({
        colspan,
        rowspan,
        content: unesc(inner).trim(),
        header: tag === 'th',
        align
      })
    }
    if (cells.length > 0) rows.push(cells)
  }
  if (rows.length === 0) return null
  return { rows }
}

/** 判断 markdown 文本块是否为 HTML 表格。 */
export function isHtmlTable(md: string): boolean {
  return /<table[\s>]/i.test(md) && /<\/table>/i.test(md)
}
