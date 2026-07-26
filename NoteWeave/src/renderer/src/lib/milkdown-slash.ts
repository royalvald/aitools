import React from 'react'
import { createRoot } from 'react-dom/client'
import { slashFactory, SlashProvider } from '@milkdown/plugin-slash'
import { commandsCtx, editorViewCtx, schemaCtx, type Editor } from '@milkdown/core'
import type { Ctx } from '@milkdown/ctx'
import type { EditorView } from '@milkdown/prose/view'
import {
  addBlockTypeCommand,
  createCodeBlockCommand,
  insertHrCommand,
  setBlockTypeCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand
} from '@milkdown/preset-commonmark'
import { insertTableCommand } from '@milkdown/preset-gfm'
import { SlashMenu, type SlashCommandAction } from '../components/SlashMenu'
import { getMathBlockType } from './milkdown-math'
import { getMermaidType } from './milkdown-mermaid'
import { extraMarksCommands } from './milkdown-extra-marks'

// 在光标处插入任意 markdown 文本（通过 ProseMirror 事务），并在其后追加正文文本。
function insertRawMarkdown(ctx: Ctx, inlineText: string, trailingText?: string): void {
  const view = ctx.get(editorViewCtx)
  const { tr, selection } = view.state
  // 包裹选区为 inlineText（若有选区）
  if (!selection.empty) {
    tr.insertText(inlineText, selection.from, selection.to)
  } else {
    tr.insertText(inlineText, selection.from)
  }
  if (trailingText) {
    // 在文档末尾追加脚注定义
    const end = view.state.doc.content.size
    tr.insertText(trailingText, end)
  }
  view.dispatch(tr)
}

/**
 * 斜杠命令插件装配（REQ-001）。
 *
 * 流程：
 * 1. slashFactory('slash') 创建一个 ProseMirror 插件，其 PluginSpec 由我们在
 *    configureSlashProvider 中通过 ctx.set(slash.key, spec) 注入。
 * 2. 在 spec.view.update 里调用 SlashProvider.update，由 provider 据编辑区状态
 *    决定显隐（trigger '/'）。
 * 3. SlashMenu 渲染到 provider 的 content 容器；shouldShow 里用 getContent 解析出
 *    `/query`，得到过滤文本与起始偏移。
 * 4. 选中命令时：先删除 `/query` 文本范围，再调用对应 Milkdown 命令插入节点。
 *
 * editorGetter：编辑器创建后才能拿到 Editor 实例，故延迟获取。
 */

const slash = slashFactory('slash')

interface SlashRuntime {
  filter: string
  slashStart: number
}

export type SlashConfig = (ctx: Ctx) => void

/**
 * 返回一个 config 函数（供 Editor.config() 使用），它把 SlashProvider 装配进 slash 插件。
 */
export function configureSlashProvider(getEditor: () => Editor | undefined): SlashConfig {
  return (ctx: Ctx) => {
    // 容器 DOM，挂载 SlashMenu
    const container = document.createElement('div')
    container.className = 'slash-menu-container'
    const root = createRoot(container)

    const runtime: SlashRuntime = { filter: '', slashStart: -1 }
    let visible = false

    const renderMenu = (): void => {
      root.render(
        React.createElement(SlashMenu, {
          filter: runtime.filter,
          onSelect: (action: SlashCommandAction) => handleSelect(action),
          onClose: () => hideMenu()
        })
      )
    }

    const hideMenu = (): void => {
      if (visible) {
        visible = false
        container.dataset.show = 'false'
        runtime.filter = ''
        runtime.slashStart = -1
      }
    }

    /** 删除 `/query` 文本范围。 */
    const clearSlashText = (): boolean => {
      const editor = getEditor()
      if (!editor) return false
      return editor.action((c) => {
        const view: EditorView = c.get(editorViewCtx)
        if (runtime.slashStart < 0) return false
        const { tr, selection } = view.state
        view.dispatch(tr.delete(runtime.slashStart, selection.to))
        return true
      })
    }

    /** 执行对应命令插入节点。 */
    const executeAction = (action: SlashCommandAction): void => {
      const editor = getEditor()
      if (!editor) return
      editor.action((c) => {
        const cmds = c.get(commandsCtx)
        const schema = c.get(schemaCtx)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodes = (schema as any).nodes
        switch (action) {
          case 'heading1':
            cmds.call(setBlockTypeCommand.key, { nodeType: nodes.heading, attrs: { level: 1 } })
            break
          case 'heading2':
            cmds.call(wrapInHeadingCommand.key, 2)
            break
          case 'heading3':
            cmds.call(wrapInHeadingCommand.key, 3)
            break
          case 'bulletList':
            cmds.call(wrapInBulletListCommand.key)
            break
          case 'orderedList':
            cmds.call(wrapInOrderedListCommand.key)
            break
          case 'taskList': {
            // 插入一个含任务项的无序列表（gfm 扩展了 list_item 的 checked 属性）
            const bullet = nodes.bullet_list.createChecked(
              null,
              nodes.list_item.create({ checked: false }, nodes.paragraph.create())
            )
            cmds.call(addBlockTypeCommand.key, { nodeType: bullet })
            break
          }
          case 'quote':
            cmds.call(wrapInBlockquoteCommand.key)
            break
          case 'codeBlock':
            cmds.call(createCodeBlockCommand.key)
            break
          case 'hr':
            cmds.call(insertHrCommand.key)
            break
          case 'table':
            cmds.call(insertTableCommand.key, { row: 3, col: 3 })
            break
          case 'math':
            cmds.call(addBlockTypeCommand.key, {
              nodeType: getMathBlockType(c),
              attrs: { value: 'E=mc^2' }
            })
            break
          case 'mermaid':
            cmds.call(addBlockTypeCommand.key, {
              nodeType: getMermaidType(c),
              attrs: { value: 'graph TD\n    A[开始] --> B[结束]' }
            })
            break
          case 'plantuml':
          case 'graphviz': {
            const lang = action === 'plantuml' ? 'plantuml' : 'dot'
            const sample =
              action === 'plantuml'
                ? '@startuml\nAlice -> Bob: 你好\nBob -> Alice: 收到\n@enduml'
                : 'digraph G {\n  A -> B;\n  B -> C;\n}'
            insertRawMarkdown(c, `\n\`\`\`${lang}\n${sample}\n\`\`\`\n`)
            break
          }
          case 'footnote': {
            // 插入脚注引用 + 定义（remark-footnotes 约定语法）
            insertRawMarkdown(c, '[^1]', '\n\n[^1]: 在此填写脚注内容')
            break
          }
          case 'highlight':
            cmds.call(extraMarksCommands.highlight)
            break
          case 'underline':
            cmds.call(extraMarksCommands.underline)
            break
          case 'superscript':
            cmds.call(extraMarksCommands.superscript)
            break
          case 'subscript':
            cmds.call(extraMarksCommands.subscript)
            break
        }
      })
    }

    const handleSelect = (action: SlashCommandAction): void => {
      clearSlashText()
      hideMenu()
      executeAction(action)
    }

    // 初始渲染（隐藏态）
    renderMenu()
    container.dataset.show = 'false'

    const provider = new SlashProvider({
      content: container,
      trigger: '/',
      debounce: 80,
      shouldShow: (view) => {
        const text = provider.getContent(view)
        if (!text) return false
        const match = text.match(/\/([^\s/]*)$/)
        if (!match) return false
        runtime.filter = match[1]
        runtime.slashStart = view.state.selection.to - match[0].length
        renderMenu()
        return true
      }
    })
    // onShow/onHide 是 SlashProvider 实例属性（不在构造选项中）
    provider.onShow = () => {
      visible = true
      container.dataset.show = 'true'
    }
    provider.onHide = () => hideMenu()

    // 把 PluginSpec 写入 slash 的 ctx，使其被 $prose 装配时采用
    ctx.set(slash.key, {
      view: () => ({
        update: (view: EditorView, prevState: EditorView['state']) =>
          provider.update(view, prevState),
        destroy: () => {
          provider.destroy()
          root.unmount()
        }
      })
    })
  }
}

export { slash }
