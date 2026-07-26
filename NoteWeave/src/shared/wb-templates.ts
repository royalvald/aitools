import type { WhiteboardElement } from './types'

// REQ-225 白板模板库：内置 6+ 模板，每个模板描述一组预置元素（便签/文本/形状）。
// 模板元素不含时间戳（应用时由调用方填充 createdAt/updatedAt）。

export interface WhiteboardTemplate {
  id: string
  name: string
  description: string
  builtin: boolean
  /** 预置元素（无 id/zIndex/时间戳，应用时生成） */
  elements: TemplateElement[]
  /** 预置框架（可选） */
  frames?: { id: string; name: string; x: number; y: number; width: number; height: number; order: number; color?: string }[]
}

// 模板元素：从 WhiteboardElement 派生但去掉 id/zIndex/时间戳
export type TemplateElement = Omit<WhiteboardElement, 'id' | 'zIndex' | 'createdAt' | 'updatedAt'>

// 创建便签的辅助
function sticky(x: number, y: number, text: string, color: string, w = 160, h = 100): TemplateElement {
  return { type: 'sticky', x, y, width: w, height: h, text, color } as TemplateElement
}
function text(x: number, y: number, t: string, size = 18): TemplateElement {
  return { type: 'text', x, y, width: 300, height: size + 12, text: t, fontSize: size, color: '#1e293b' } as TemplateElement
}
function shape(x: number, y: number, w: number, h: number, kind: 'rect' | 'rounded-rect' = 'rounded-rect', label = ''): TemplateElement {
  return { type: 'shape', shape: kind, x, y, width: w, height: h, text: label, fill: '#fff', stroke: '#475569', strokeWidth: 2 } as TemplateElement
}

export const BUILTIN_WB_TEMPLATES: WhiteboardTemplate[] = [
  {
    id: 'wb-blank',
    name: '空白',
    description: '空白画布',
    builtin: true,
    elements: []
  },
  {
    id: 'wb-brainstorm',
    name: '头脑风暴',
    description: '中心主题 + 四象限发散',
    builtin: true,
    elements: [
      shape(400, 320, 240, 100, 'rounded-rect', '中心主题'),
      sticky(120, 120, '想法 A', '#fef9c3'),
      sticky(120, 520, '想法 B', '#dcfce7'),
      sticky(720, 120, '想法 C', '#dbeafe'),
      sticky(720, 520, '想法 D', '#fce7f3')
    ]
  },
  {
    id: 'wb-journey',
    name: '用户旅程',
    description: '发现 → 购买 → 使用 → 推荐',
    builtin: true,
    elements: [
      text(60, 60, '用户旅程地图', 22),
      shape(60, 160, 180, 80, 'rounded-rect', '发现'),
      shape(300, 160, 180, 80, 'rounded-rect', '购买'),
      shape(540, 160, 180, 80, 'rounded-rect', '使用'),
      shape(780, 160, 180, 80, 'rounded-rect', '推荐'),
      sticky(80, 280, '触点/痛点', '#fef9c3'),
      sticky(320, 280, '触点/痛点', '#dcfce7'),
      sticky(560, 280, '触点/痛点', '#dbeafe'),
      sticky(800, 280, '触点/痛点', '#fce7f3')
    ]
  },
  {
    id: 'wb-swot',
    name: 'SWOT 分析',
    description: '优势/劣势/机会/威胁',
    builtin: true,
    elements: [
      text(360, 40, 'SWOT 分析', 22),
      sticky(120, 120, 'S 优势', '#dcfce7', 280, 200),
      sticky(440, 120, 'W 劣势', '#fee2e2', 280, 200),
      sticky(120, 360, 'O 机会', '#dbeafe', 280, 200),
      sticky(440, 360, 'T 威胁', '#fef9c3', 280, 200)
    ]
  },
  {
    id: 'wb-weekly',
    name: '个人周回顾',
    description: '本周完成/下周计划/反思',
    builtin: true,
    elements: [
      text(300, 40, '本周回顾', 22),
      sticky(80, 120, '本周完成', '#dcfce7', 280, 260),
      sticky(400, 120, '下周计划', '#dbeafe', 280, 260),
      sticky(720, 120, '反思与感谢', '#fce7f3', 280, 260)
    ]
  },
  {
    id: 'wb-kanban',
    name: '项目看板',
    description: '待办/进行中/已完成',
    builtin: true,
    elements: [
      text(320, 40, '项目看板', 22),
      sticky(60, 120, '待办', '#fef9c3', 280, 60),
      sticky(400, 120, '进行中', '#dbeafe', 280, 60),
      sticky(740, 120, '已完成', '#dcfce7', 280, 60),
      sticky(80, 200, '任务 1', '#fef9c3', 240, 80),
      sticky(80, 300, '任务 2', '#fef9c3', 240, 80),
      sticky(420, 200, '任务 3', '#dbeafe', 240, 80),
      sticky(760, 200, '任务 4', '#dcfce7', 240, 80)
    ]
  },
  {
    id: 'wb-reading',
    name: '读书笔记',
    description: '摘录/心得/行动',
    builtin: true,
    elements: [
      text(320, 40, '读书笔记', 22),
      sticky(60, 120, '摘录', '#dbeafe', 280, 280),
      sticky(400, 120, '心得', '#fce7f3', 280, 280),
      sticky(740, 120, '行动项', '#dcfce7', 280, 280)
    ]
  },
  {
    id: 'wb-decision',
    name: '决策矩阵',
    description: '方案 × 维度评分',
    builtin: true,
    elements: [
      text(300, 40, '决策矩阵', 22),
      shape(60, 120, 720, 60, 'rect', ''),
      shape(60, 180, 720, 60, 'rect', ''),
      shape(60, 240, 720, 60, 'rect', ''),
      text(80, 140, '方案'),
      text(260, 140, '维度 1'),
      text(440, 140, '维度 2'),
      text(620, 140, '总分')
    ]
  }
]
