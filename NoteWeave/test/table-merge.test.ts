import { describe, it, expect } from 'vitest'
import {
  tableToHtml,
  htmlToTable,
  hasMergedCells,
  isHtmlTable
} from '../src/renderer/src/lib/table-merge-serialize'

describe('table-merge-serialize 往返', () => {
  it('tableToHtml 输出带 colspan/rowspan 的 HTML', () => {
    const grid = {
      rows: [
        [
          { colspan: 2, rowspan: 1, content: '合并表头', header: true, align: 'center' as const },
          { colspan: 1, rowspan: 2, content: '纵向合并', header: false, align: 'left' as const }
        ],
        [
          { colspan: 1, rowspan: 1, content: 'a', header: false, align: 'left' as const },
          { colspan: 1, rowspan: 1, content: 'b', header: false, align: 'left' as const }
          // 第三格由上一行 rowspan 覆盖，故此处只列 2 个
        ]
      ]
    }
    const html = tableToHtml(grid)
    expect(html).toContain('colspan="2"')
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('<th')
    expect(html).toContain('text-align: center')
  })

  it('htmlToTable 解析回相同结构', () => {
    const html = `<table>
  <tr>
    <th colspan="2" style="text-align: center">合并表头</th>
    <td rowspan="2">纵向合并</td>
  </tr>
  <tr>
    <td>a</td>
    <td>b</td>
  </tr>
</table>`
    const grid = htmlToTable(html)
    expect(grid).not.toBeNull()
    expect(grid!.rows.length).toBe(2)
    expect(grid!.rows[0][0].colspan).toBe(2)
    expect(grid!.rows[0][0].header).toBe(true)
    expect(grid!.rows[0][0].align).toBe('center')
    expect(grid!.rows[0][1].rowspan).toBe(2)
    expect(grid!.rows[0][1].content).toBe('纵向合并')
    expect(grid!.rows[1][0].content).toBe('a')
  })

  it('htmlToTable 处理 HTML 实体转义', () => {
    const html = '<table><tr><td>a &amp; b &lt;tag&gt;</td></tr></table>'
    const grid = htmlToTable(html)!
    expect(grid.rows[0][0].content).toBe('a & b <tag>')
  })

  it('往返一致性：复杂表格 serialize→parse 等价', () => {
    const original = {
      rows: [
        [
          { colspan: 2, rowspan: 1, content: '标题', header: true, align: 'center' as const },
          { colspan: 1, rowspan: 2, content: '跨行', header: false, align: 'right' as const }
        ],
        [
          { colspan: 1, rowspan: 1, content: 'x', header: false, align: 'left' as const },
          { colspan: 1, rowspan: 1, content: 'y & z', header: false, align: 'left' as const }
        ]
      ]
    }
    const html = tableToHtml(original)
    const back = htmlToTable(html)!
    expect(back.rows.length).toBe(original.rows.length)
    // 逐格比对
    for (let r = 0; r < original.rows.length; r++) {
      for (let c = 0; c < original.rows[r].length; c++) {
        const a = original.rows[r][c]
        const b = back.rows[r][c]
        expect(b.colspan).toBe(a.colspan)
        expect(b.rowspan).toBe(a.rowspan)
        expect(b.content).toBe(a.content)
        expect(b.header).toBe(a.header)
        expect(b.align).toBe(a.align)
      }
    }
  })

  it('hasMergedCells 检测合并', () => {
    expect(hasMergedCells({ rows: [[{ colspan: 1, rowspan: 1, content: 'x', header: false, align: 'left' }]] })).toBe(false)
    expect(hasMergedCells({ rows: [[{ colspan: 2, rowspan: 1, content: 'x', header: false, align: 'left' }]] })).toBe(true)
    expect(hasMergedCells({ rows: [[{ colspan: 1, rowspan: 3, content: 'x', header: false, align: 'left' }]] })).toBe(true)
  })

  it('isHtmlTable 识别 HTML 表格块', () => {
    expect(isHtmlTable('<table><tr><td>a</td></tr></table>')).toBe(true)
    expect(isHtmlTable('| a | b |\n| - | - |')).toBe(false)
  })

  it('htmlToTable 对非表格返回 null', () => {
    expect(htmlToTable('普通文本')).toBeNull()
    expect(htmlToTable('| a | b |')).toBeNull()
  })

  it('默认 colspan/rowspan 为 1（无属性时）', () => {
    const grid = htmlToTable('<table><tr><td>x</td></tr></table>')!
    expect(grid.rows[0][0].colspan).toBe(1)
    expect(grid.rows[0][0].rowspan).toBe(1)
    expect(grid.rows[0][0].align).toBe('left')
  })
})
