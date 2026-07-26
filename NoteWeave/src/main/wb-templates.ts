import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { WhiteboardElement, WhiteboardFrame } from '../shared/types'
import { BUILTIN_WB_TEMPLATES, type WhiteboardTemplate } from '../shared/wb-templates'

// REQ-225 白板模板：内置 8 种 + 用户自定义（{userData}/templates/whiteboard/*.json）。

function getWbTemplatesDir(): string {
  return path.join(app.getPath('userData'), 'templates', 'whiteboard')
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

// 列出全部模板（内置 + 用户）
export async function listWbTemplates(): Promise<WhiteboardTemplate[]> {
  const user: WhiteboardTemplate[] = []
  try {
    const dir = getWbTemplatesDir()
    const files = await fs.readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf-8')
        const t = JSON.parse(raw) as WhiteboardTemplate
        user.push({ ...t, builtin: false })
      } catch {
        // ignore single corrupted
      }
    }
  } catch {
    // dir not exist
  }
  return [...BUILTIN_WB_TEMPLATES, ...user]
}

// 保存当前白板为自定义模板
export async function saveWbTemplate(
  name: string,
  elements: WhiteboardElement[],
  frames: WhiteboardFrame[] = []
): Promise<WhiteboardTemplate> {
  await ensureDir(getWbTemplatesDir())
  const tpl: WhiteboardTemplate = {
    id: uuidv4(),
    name: name.trim() || '自定义模板',
    description: '用户保存的模板',
    builtin: false,
    // 元素去掉 id/zIndex/时间戳（仅保留模板所需的几何/文本/样式字段）
    elements: elements.map((el) => {
      const e = el as unknown as Record<string, unknown>
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) {
        if (k !== 'id' && k !== 'zIndex' && k !== 'createdAt' && k !== 'updatedAt') {
          rest[k] = v
        }
      }
      return rest as never
    }) as WhiteboardTemplate['elements'],
    frames: frames.map((f) => ({
      id: 'frame',
      name: f.name,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      order: f.order,
      color: f.color
    }))
  }
  await fs.writeFile(
    path.join(getWbTemplatesDir(), `${tpl.id}.json`),
    JSON.stringify(tpl, null, 2),
    'utf-8'
  )
  return tpl
}

// 删除用户模板
export async function deleteWbTemplate(id: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(getWbTemplatesDir(), `${id}.json`))
    return true
  } catch {
    return false
  }
}
