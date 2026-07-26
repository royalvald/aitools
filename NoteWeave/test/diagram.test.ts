import { describe, it, expect } from 'vitest'
import { renderPlantUmlLocal } from '../src/main/plantuml-local'

// REQ-115：Graphviz / PlantUML 本地渲染冒烟测试。
// PlantUML 部分测试纯 JS 内置渲染器（无需 Java/jar/联网）。
// Graphviz（@viz-js/viz 纯 WASM）在 Node 环境下可独立初始化，这里直接测其渲染。

describe('PlantUML 本地渲染器（纯 JS，零依赖）', () => {
  it('序列图渲染为 SVG', () => {
    const src = `@startuml
Alice -> Bob: 你好
Bob --> Alice: 收到
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('sequence')
    expect(r.svg).toContain('<svg')
    expect(r.svg).toContain('Alice')
    expect(r.svg).toContain('Bob')
  })

  it('类图渲染为 SVG', () => {
    const src = `@startuml
class Animal
class Dog
Dog --|> Animal
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('class')
    expect(r.svg).toContain('<svg')
    expect(r.svg).toContain('Animal')
    expect(r.svg).toContain('Dog')
  })

  it('类图含成员渲染', () => {
    const src = `@startuml
class User {
  +name: String
  +age: int
}
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('User')
    expect(r.svg).toContain('+name: String')
  })

  it('自调用消息（self message）', () => {
    const src = `@startuml
A -> A: 自调用
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('<svg')
  })

  it('忽略 skinparam/theme/scale 不崩溃', () => {
    const src = `@startuml
skinparam backgroundColor white
!theme cerulean
scale 2
A -> B: msg
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
  })

  it('未知类型回退为源码展示（不崩溃）', () => {
    const src = `@startuml
some unknown syntax here
xxx yyy zzz
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.ok).toBe(true)
    expect(r.svg).toContain('<svg')
  })

  it('空源码返回失败', () => {
    const r = renderPlantUmlLocal('')
    expect(r.ok).toBe(false)
  })

  it('SVG 包含箭头 marker 定义（序列图）', () => {
    const src = `@startuml
A -> B: hi
@enduml`
    const r = renderPlantUmlLocal(src)
    expect(r.svg).toContain('marker')
  })
})

describe('Graphviz 本地渲染（纯 WASM @viz-js/viz）', () => {
  it('简单 dot 渲染为 SVG', async () => {
    const viz = await import('@viz-js/viz')
    const instance = await viz.instance()
    const svg = instance.renderString('digraph G { A -> B; B -> C; }', { format: 'svg' })
    expect(svg).toContain('<svg')
    expect(svg.length).toBeGreaterThan(100)
  })

  it('复杂 dot（带标签）渲染', async () => {
    const viz = await import('@viz-js/viz')
    const instance = await viz.instance()
    const svg = instance.renderString('digraph { rankdir=LR; A [label="开始"]; B [label="结束"]; A -> B [label="下一步"]; }', { format: 'svg' })
    expect(svg).toContain('<svg')
  })
})
