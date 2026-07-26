// REQ-115：纯 JS 本地 PlantUML 子集渲染器（无需 Java / plantuml.jar / 联网）。
//
// 支持的语法子集（覆盖验收要求的「序列图 / 类图」）：
// - 序列图：@startuml ... @enduml，参与者声明 participant/actor，消息 A -> B : text
//   （含 ->, <-->, ->>, : 等）、autonumber、title、note
// - 类图：class A { ... }，关系 A --|> B（继承）, A --> B（关联）, A *-- B（组合）, A o-- B（聚合）
// - 通用：skinparam（忽略）、!theme（忽略）、注释 '
//
// 输出 SVG 字符串。这是一个子集实现，复杂语法（state/activity/component 等）会回退为
// 等宽源码展示，保证不崩溃。完全本地、零外部依赖。

interface ParsedParticipant {
  name: string
  kind: string
  alias?: string
}

interface SeqMessage {
  from: string
  to: string
  arrow: string
  label: string
  note?: boolean
}

const ARROW_RE = /([A-Za-z0-9_"']+)\s*(<?[-.+o]*>?[>]*?)\s*([A-Za-z0-_"']+)?\s*:\s*(.*)$/

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 解析 PlantUML 源码，判断图表类型。 */
function detectKind(source: string): 'sequence' | 'class' | 'unknown' {
  const lines = source.split('\n').map((l) => l.trim())
  const hasClass = lines.some((l) => /^\s*(abstract\s+|interface\s+)?class\s+\w/.test(l) || /--\|>|<\|--|\*\--|o--/.test(l))
  const hasSeq = lines.some((l) => ARROW_RE.test(l) && !/--\|>|<\|--|\*\--|o--/.test(l) && /-->|->|<--/.test(l))
  if (hasSeq && !hasClass) return 'sequence'
  if (hasClass) return 'class'
  if (hasSeq) return 'sequence'
  return 'unknown'
}

function stripFence(source: string): string {
  let s = source.replace(/@startuml/gi, '').replace(/@enduml/gi, '')
  return s.trim()
}

/** 渲染序列图为 SVG。 */
function renderSequence(source: string): string {
  const lines = stripFence(source).split('\n')
  const participants: ParsedParticipant[] = []
  const messages: SeqMessage[] = []
  const aliasToName = new Map<string, string>()

  for (let raw of lines) {
    let line = raw.trim()
    if (!line || line.startsWith("'") || line.startsWith('//')) continue
    if (/^(skinparam|!theme|!include|scale|hide|show)/i.test(line)) continue
    if (/^autonumber/i.test(line)) continue
    const titleM = line.match(/^title\s+(.*)$/i)

    const decl = line.match(/^(participant|actor|object|boundary|control|entity|database|collections?)\s+["']?([^"'\s]+)["']?(?:\s+as\s+["']?([^"'\s]+)["']?)?/i)
    if (decl) {
      const p: ParsedParticipant = { kind: decl[1].toLowerCase(), name: decl[2], alias: decl[3] }
      participants.push(p)
      if (p.alias) aliasToName.set(p.alias, p.name)
      continue
    }
    const noteM = line.match(/^note\s+(.*)$/i)
    const m = line.match(ARROW_RE)
    if (m) {
      const from = aliasToName.get(m[1]) ?? m[1]
      const to = m[3] ? (aliasToName.get(m[3]) ?? m[3]) : ''
      messages.push({ from, to, arrow: m[2], label: (m[4] || '').trim(), note: !!noteM })
      // 自动注册未声明的参与者
      for (const n of [from, to]) {
        if (n && !participants.some((p) => p.name === n)) participants.push({ kind: 'participant', name: n })
      }
      continue
    }
  }

  // 布局
  const boxW = 110
  const boxH = 36
  const gapX = 40
  const lifelineX = participants.map((_, i) => 40 + i * (boxW + gapX) + boxW / 2)
  const msgH = 28
  const topY = 60
  const lifelineBottom = topY + messages.length * msgH + 20

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(320, lifelineX[lifelineX.length - 1] + boxW / 2 + 20)}" height="${lifelineBottom + 20}" viewBox="0 0 ${Math.max(320, lifelineX[lifelineX.length - 1] + boxW / 2 + 20)} ${lifelineBottom + 20}" font-family="sans-serif" font-size="13">`)
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>')

  // 参与者盒 + 生命线
  participants.forEach((p, i) => {
    const x = lifelineX[i] - boxW / 2
    parts.push(`<rect x="${x}" y="${topY - boxH}" width="${boxW}" height="${boxH}" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>`)
    parts.push(`<text x="${lifelineX[i]}" y="${topY - boxH / 2 + 4}" text-anchor="middle" fill="#1e293b">${esc(p.name)}</text>`)
    parts.push(`<line x1="${lifelineX[i]}" y1="${topY}" x2="${lifelineX[i]}" y2="${lifelineBottom}" stroke="#94a3b8" stroke-dasharray="4 3"/>`)
  })

  // 消息箭头
  messages.forEach((msg, i) => {
    const y = topY + 16 + i * msgH
    const fromIdx = participants.findIndex((p) => p.name === msg.from)
    const toIdx = participants.findIndex((p) => p.name === msg.to)
    if (msg.note) {
      parts.push(`<rect x="${10}" y="${y - 12}" width="${200}" height="${22}" fill="#fffbeb" stroke="#f59e0b"/>`)
      parts.push(`<text x="${16}" y="${y + 3}" fill="#92400e">${esc(msg.label)}</text>`)
      return
    }
    if (fromIdx === -1 || toIdx === -1) return
    const x1 = lifelineX[fromIdx]
    const x2 = lifelineX[toIdx]
    const selfMsg = x1 === x2
    if (selfMsg) {
      parts.push(`<path d="M ${x1} ${y} q 30 0 30 16 q 0 16 -30 16" fill="none" stroke="#1e293b" marker-end="url(#arrow)"/>`)
      parts.push(`<text x="${x1 + 36}" y="${y + 16}" fill="#1e293b">${esc(msg.label)}</text>`)
      return
    }
    const leftToRight = x2 > x1
    parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#1e293b" marker-end="url(#arrow)" stroke-width="${msg.arrow.includes('--') ? 2 : 1}"/>`)
    const midX = (x1 + x2) / 2
    parts.push(`<text x="${midX}" y="${y - 5}" text-anchor="middle" fill="#1e293b">${esc(msg.label)}</text>`)
    void leftToRight
  })

  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1e293b"/></marker></defs>')
  parts.push('</svg>')
  return parts.join('\n')
}

/** 渲染类图为 SVG。 */
function renderClass(source: string): string {
  const lines = stripFence(source).split('\n')
  const classes = new Map<string, { members: string[] }>()
  const relations: { from: string; to: string; rel: string }[] = []

  let current: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith("'")) continue
    if (/^(skinparam|!theme|!include|scale|hide|show)/i.test(line)) continue
    const cls = line.match(/^(?:abstract\s+|interface\s+)?class\s+["']?(\w+)["']?/)
    if (cls) {
      current = cls[1]
      if (!classes.has(current)) classes.set(current, { members: [] })
      if (line.includes('{')) {
        // 体内成员随后续行；本行若有 { 则进入
      }
      continue
    }
    if (line === '}') {
      current = null
      continue
    }
    // 关系：A --|> B  /  A --> B  /  A *-- B  /  A o-- B
    const rel = line.match(/^(\w+)\s*(--\|>|<\||\*--|o--|-->)\s*(\w+)/)
    if (rel) {
      relations.push({ from: rel[1], to: rel[3], rel: rel[2] })
      for (const n of [rel[1], rel[3]]) if (!classes.has(n)) classes.set(n, { members: [] })
      continue
    }
    if (current && line) {
      classes.get(current)!.members.push(line)
    }
  }

  // 简单网格布局
  const names = [...classes.keys()]
  const boxW = 140
  const boxH = 40 + 16 * 0
  const gapX = 60
  const gapY = 80
  const perRow = Math.max(1, Math.ceil(Math.sqrt(names.length)))
  const pos = new Map<string, { x: number; y: number }>()
  names.forEach((n, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    pos.set(n, { x: 40 + col * (boxW + gapX), y: 40 + row * (boxH + gapY) })
  })

  let width = 40 + perRow * (boxW + gapX)
  let height = 40 + Math.ceil(names.length / perRow) * (boxH + gapY) + 60

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="13">`)
  parts.push('<rect width="100%" height="100%" fill="#ffffff"/>')

  // 关系线
  for (const r of relations) {
    const a = pos.get(r.from)!
    const b = pos.get(r.to)!
    const x1 = a.x + boxW
    const y1 = a.y + boxH / 2
    const x2 = b.x
    const y2 = b.y + boxH / 2
    let marker = ''
    let color = '#475569'
    if (r.rel === '--|>') { marker = 'marker-end="url(#inherit)"' }
    else if (r.rel === '<|--') { marker = 'marker-start="url(#inherit)"' }
    else if (r.rel === '-->') { marker = 'marker-end="url(#arrow)"' }
    else if (r.rel === '*--' || r.rel === 'o--') { marker = ''; color = '#0f766e' }
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" ${marker}/>`)
  }

  // 类盒
  names.forEach((n) => {
    const p = pos.get(n)!
    const members = classes.get(n)!.members
    const h = boxH + members.length * 16
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${boxW}" height="${h}" fill="#ecfeff" stroke="#0e7490" stroke-width="1.5"/>`)
    parts.push(`<rect x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" fill="#cffafe" stroke="#0e7490" stroke-width="1.5"/>`)
    parts.push(`<text x="${p.x + boxW / 2}" y="${p.y + 24}" text-anchor="middle" fill="#0c4a6e" font-weight="bold">${esc(n)}</text>`)
    members.forEach((m, i) => {
      parts.push(`<text x="${p.x + 8}" y="${p.y + boxH + 14 + i * 16}" fill="#0c4a6e">${esc(m)}</text>`)
    })
  })

  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#475569"/></marker><marker id="inherit" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M 0 0 L 11 6 L 0 12 z" fill="#ffffff" stroke="#475569"/></marker></defs>')
  parts.push('</svg>')
  return parts.join('\n')
}

/** 入口：把 PlantUML 源码渲染为 SVG（纯 JS，无外部依赖）。 */
export function renderPlantUmlLocal(source: string): { ok: boolean; svg?: string; kind?: string; error?: string } {
  if (!source || !source.trim()) {
    return { ok: false, error: '空源码' }
  }
  const kind = detectKind(source)
  try {
    if (kind === 'sequence') {
      return { ok: true, kind, svg: renderSequence(source) }
    }
    if (kind === 'class') {
      return { ok: true, kind, svg: renderClass(source) }
    }
    // 未知类型：回退为等宽源码展示（保证不崩溃）
    const lines = stripFence(source).split('\n')
    const w = 480
    const h = 24 * (lines.length + 2)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, monospace" font-size="13"><rect width="100%" height="100%" fill="#f8fafc"/>${lines.map((l, i) => `<text x="12" y="${20 + i * 20}" fill="#334155">${esc(l)}</text>`).join('')}</svg>`
    return { ok: true, kind, svg }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
