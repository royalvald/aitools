import { $nodeSchema } from '@milkdown/utils'
import { tableNodes } from '@milkdown/prose/tables'
import type { Node } from '@milkdown/prose/model'
import {
  tableToHtml,
  hasMergedCells,
  type TableGrid,
  type GridCell
} from './table-merge-serialize'

/**
 * REQ-105：合并单元格的 Markdown 往返序列化（Milkdown 端桥接）。
 *
 * Milkdown gfm 表格的内置 toMarkdown 只输出 GFM 表格语法（不支持 colspan/rowspan），
 * 合并信息会丢失。本模块覆盖 table schema 的 toMarkdown runner：
 * - 若表格任意单元格 colspan>1 或 rowspan>1，则把整个表格序列化为原始 HTML <table>
 *   （保留 colspan/rowspan/对齐/表头），输出 mdast html 节点；
 * - 否则走默认 GFM 表格输出，保持与普通表格一致。
 *
 * 这样在源码模式/导出 Markdown 中，合并信息以 HTML 表格形式被正确保留，
 * 满足「合并单元格后 Markdown 源码正确」的验收项。
 * 解析端由 Milkdown 默认 html 节点处理；纯函数往返见 table-merge-serialize.ts（已单测覆盖）。
 */

const original = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph',
  cellAttributes: {
    alignment: {
      default: 'left',
      getFromDOM: (dom: HTMLElement) => dom.style.textAlign || 'left',
      setDOMAttr: (value: string, attrs: Record<string, unknown>) => {
        attrs.style = `text-align: ${value || 'left'}`
      }
    }
  } as never
})

// 把 ProseMirror 表格节点转为 TableGrid（含合并信息）
function nodeToGrid(tableNode: Node): TableGrid {
  const rows: GridCell[][] = []
  tableNode.forEach((row) => {
    const cells: GridCell[] = []
    row.forEach((cell) => {
      // 单元格文本内容：拼接所有段落的纯文本
      let content = ''
      cell.forEach((child) => {
        if (child.isText) {
          content += child.text ?? ''
        } else {
          content += child.textContent
        }
      })
      const align = (cell.attrs.alignment || 'left') as GridCell['align']
      cells.push({
        colspan: cell.attrs.colspan || 1,
        rowspan: cell.attrs.rowspan || 1,
        content: content.trim(),
        header: cell.type.name === 'table_header',
        align
      })
    })
    if (cells.length > 0) rows.push(cells)
  })
  return { rows }
}

// 覆盖 table schema 的 toMarkdown：有合并时输出 HTML 表格
export const tableMergeSchema = $nodeSchema('table', () => ({
  ...original.table,
  content: 'table_header_row table_row+',
  // parseMarkdown 复用原始（GFM table 节点）；HTML 表格在渲染端按 html 块处理
  parseMarkdown: {
    match: (node) => node.type === 'table',
    runner: (state, node, type) => {
      const align = node.align as (string | null)[]
      const children = (node.children as { type: string }[]).map((x, i) => ({
        ...x,
        align,
        isHeader: i === 0
      }))
      state.openNode(type)
      state.next(children)
      state.closeNode()
    }
  },
  toMarkdown: {
    match: (node) => node.type.name === 'table',
    runner: (state, node) => {
      const grid = nodeToGrid(node)
      if (hasMergedCells(grid)) {
        // 输出 HTML 表格（mdast html 节点），保留合并信息
        const html = tableToHtml(grid)
        state.addNode('html', undefined, html)
        return
      }
      // 默认 GFM 表格输出
      const firstLine = node.content.firstChild?.content
      if (!firstLine) return
      const align: (string | null)[] = []
      firstLine.forEach((cell) => {
        align.push(cell.attrs.alignment)
      })
      state.openNode('table', undefined, { align })
      state.next(node.content)
      state.closeNode()
    }
  }
}))
