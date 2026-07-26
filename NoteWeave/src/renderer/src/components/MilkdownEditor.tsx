import { useEffect, useRef, useState } from 'react'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import { Editor, defaultValueCtx, rootCtx, editorViewCtx, commandsCtx } from '@milkdown/core'
import { commonmark, toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand } from '@milkdown/preset-commonmark'
import { gfm, toggleStrikethroughCommand } from '@milkdown/preset-gfm'
import { nord } from '@milkdown/theme-nord'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { history } from '@milkdown/plugin-history'
import { prism } from '@milkdown/plugin-prism'
import { TextSelection } from 'prosemirror-state'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import { mergeCells, splitCell, CellSelection } from '@milkdown/prose/tables'
import { ImageContextMenu } from './ImageContextMenu'
import { useToast } from './Toast'
import { useConfirm } from './ConfirmDialog'
import { useImageContextMenu } from '../hooks/useImageContextMenu'
import {
  remarkMathPlugin,
  mathInlineSchema,
  mathInlineView,
  mathBlockSchema,
  mathBlockView
} from '../lib/milkdown-math'
import {
  remarkMermaid,
  mermaidSchema,
  mermaidView
} from '../lib/milkdown-mermaid'
import {
  remarkExtraMarks,
  remarkFootnoteLinks,
  highlightMark,
  underlineMark,
  superscriptMark,
  subscriptMark,
  toggleHighlight,
  toggleUnderline,
  toggleSuperscript,
  toggleSubscript,
  extraMarksCommands
} from '../lib/milkdown-extra-marks'
import { tableMergeSchema } from '../lib/milkdown-table-merge'
import { placeholderPlugin, placeholderTextCtx } from '../lib/milkdown-placeholder'
import { slash, configureSlashProvider } from '../lib/milkdown-slash'
import { SelectionBubble, type BubbleAction, type BubblePosition } from './SelectionBubble'
import { uploadFile } from '../lib/assets'
import {
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  deleteSelectedCellsCommand,
  setAlignCommand,
  selectRowCommand,
  selectColCommand
} from '@milkdown/preset-gfm'
import '@milkdown/theme-nord/style.css'
import type { Ctx } from '@milkdown/ctx'

/**
 * 防御性获取 EditorView：Milkdown 编辑器异步创建，完成前 ctx.get(editorViewCtx)
 * 可能返回未就绪的值（无 state），此时应视为「编辑器尚未就绪」而非崩溃。
 */
function safeGetView(ctx: Ctx): EditorView | null {
  try {
    const view = ctx.get(editorViewCtx)
    return view && view.state ? view : null
  } catch {
    return null
  }
}

/** MilkdownEditor 对外暴露的命令式接口（查找/替换 / 自动配对等由父组件驱动）。 */
export interface MilkdownEditorApi {
  /**
   * 在文档纯文本（doc.textContent）中定位 text 的第 occurrence 次出现（0 起）并选中。
   * 枚举所有出现位置取第 N 个，重复文本可正确定位到第 N 处。
   */
  selectTextOccurrence: (text: string, occurrence: number) => void
  /** 替换文档纯文本中 text 的第 occurrence 次出现（0 起）。 */
  replaceTextOccurrence: (text: string, occurrence: number, replacement: string) => void
  /** 在光标处插入任意 markdown 文本（斜杠命令/工具栏复用）。 */
  insertMarkdown: (text: string) => void
  /** REQ-105：执行表格编辑命令（增删行列、对齐、合并/拆分）。 */
  runTableCommand: (
    cmd:
      | 'addRowBefore'
      | 'addRowAfter'
      | 'addColBefore'
      | 'addColAfter'
      | 'deleteCells'
      | 'alignLeft'
      | 'alignCenter'
      | 'alignRight'
      | 'selectRow'
      | 'selectCol'
      | 'mergeCells'
      | 'splitCell'
  ) => void
  /** REQ-105：当前选区是否处于表格单元格内。 */
  isInTable: () => boolean
  /** REQ-105：当前是否选了多个单元格（可合并）。 */
  hasCellSelection: () => boolean
  /** REQ-105：当前光标所在单元格是否为已合并单元格（可拆分）。 */
  isMergedCell: () => boolean
  /** 当前编辑器是否就绪。 */
  isReady: () => boolean
}

interface MilkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** REQ-004/016 资源归属（决定保存目录）。提供后启用图片粘贴/拖拽上传。 */
  assetScope?: { scope: 'note' | 'kb'; ownerId: string }
  /** REQ-101：外部控制器（查找替换）通过该回调获得命令式接口。 */
  onApi?: (api: MilkdownEditorApi) => void
  /** REQ-107：是否启用 Focus 模式（淡化非当前段落）。 */
  focusMode?: boolean
  /** REQ-107：是否启用打字机模式（当前行居中）。 */
  typewriterMode?: boolean
  /** REQ-113：拼写检查。 */
  spellcheck?: boolean
  /** REQ-114：自动配对开关（true 时启用输入规则自动补全）。 */
  autoPair?: boolean
}

// REQ-101：查找定位的纯文本工具。
//
// doc.textContent 把各文本节点内容无缝拼接（段落间无分隔符），因此
// textOffsetToPos 也按「仅文本节点累加长度」把纯文本偏移映射回 ProseMirror 位置。

/** 在 text 中枚举 sub 的所有出现位置，返回第 n 个（0 起）的起始下标；不足 n+1 处返回 -1。 */
function findNthOccurrence(text: string, sub: string, n: number): number {
  if (!sub) return -1
  let idx = -1
  for (let i = 0; i <= n; i++) {
    idx = text.indexOf(sub, idx + 1)
    if (idx === -1) return -1
  }
  return idx
}

/** 纯文本偏移 → ProseMirror 文档位置（与 doc.textContent 的拼接方式一一对应）。 */
function textOffsetToPos(doc: PMNode, offset: number): number {
  let acc = 0
  let result = -1
  doc.descendants((node, pos) => {
    if (result >= 0) return false
    if (node.isText) {
      const len = node.text?.length ?? 0
      if (offset <= acc + len) {
        result = pos + (offset - acc)
        return false
      }
      acc += len
    }
    return true
  })
  return result >= 0 ? result : doc.content.size
}

// Ctrl+K 插入链接：在 React 层拦截（见容器 onKeyDown），唤起选区气泡菜单的链接输入框，
// 替代 window.prompt（Typora 式内联 popover）。

/** REQ-107 专注模式：给光标所在的顶层块元素加 is-current，其余顶层块移除。 */
function markCurrentBlock(view: EditorView) {
  const pm = view.dom as HTMLElement
  const { $from } = view.state.selection
  let current: HTMLElement | null = null
  if ($from.depth >= 1) {
    const dom = view.nodeDOM($from.before(1))
    if (dom instanceof HTMLElement && dom.parentElement === pm) current = dom
  }
  for (const child of Array.from(pm.children)) {
    if (child === current) child.classList.add('is-current')
    else child.classList.remove('is-current')
  }
}

/** REQ-107 打字机模式：滚动外层滚动容器（.milkdown-editor），使光标保持在视口垂直居中附近。 */
function scrollCursorToCenter(view: EditorView, container: HTMLElement | null) {
  if (!container) return
  const coords = view.coordsAtPos(view.state.selection.anchor)
  const rect = container.getBoundingClientRect()
  container.scrollTop += coords.top - (rect.top + rect.height / 2)
}

/**
 * 基于 Milkdown 的所见即所得 Markdown 编辑器（REQ-001 WYSIWYG 模式）。
 *
 * - 预设：commonmark + gfm（表格/任务列表/删除线等）+ nord 主题。
 * - 监听器：markdown 变化时回写父组件（与现有 MDEditor 的 value/onChange 接口一致）。
 * - 历史：支持撤销/重做。
 * - prism：代码块语法高亮。
 * - LaTeX 公式（REQ-002）：行内 `$...$` 与块级 `$$...$$` 在编辑态即时渲染 KaTeX。
 * - Mermaid 图表（REQ-003）：编辑态实时渲染 SVG，双击可改源码。
 * - 斜杠命令（REQ-001）：输入 `/` 弹出命令菜单（标题/列表/公式/Mermaid 等）。
 * - 快捷键：Ctrl+B/I 由 commonmark 内置；Ctrl+K 唤起选区气泡菜单的链接输入框。
 * - 选区气泡菜单（Typora 式）：选中文字浮现 加粗/斜体/删除线/高亮/行内代码/链接。
 * - 空文档占位提示（placeholder prop）：仅剩一个空段落时显示引导文案。
 *
 * 说明：slash 命令需要延迟获取 editor 实例（编辑器创建后才有），通过 ref 传递。
 */
function MilkdownEditorInner({ value, onChange, placeholder, assetScope, onApi, focusMode, typewriterMode, spellcheck, autoPair }: MilkdownEditorProps) {
  const toast = useToast()
  const confirm = useConfirm()
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // 专注/打字机开关的最新值，供编辑器 config 内注册的 selectionUpdated 监听读取
  //（config 只在编辑器创建时执行一次，需通过 ref 取当前 prop）
  const focusModeRef = useRef(focusMode)
  focusModeRef.current = focusMode
  const typewriterRef = useRef(typewriterMode)
  typewriterRef.current = typewriterMode
  const containerRef = useRef<HTMLDivElement>(null)
  // 持有 editor 实例 getter，供 slash 命令延迟取用
  const editorGetterRef = useRef<() => Editor | undefined>(() => undefined)
  // 选区气泡菜单（Typora/Notion 式）：非空文本选区浮现于选区上方。
  const [bubble, setBubble] = useState<BubblePosition | null>(null)
  // Ctrl+K 唤起气泡链接输入框的信号（递增计数，SelectionBubble 监听变化）
  const [linkSignal, setLinkSignal] = useState(0)
  // config 只在编辑器创建时执行一次，选区监听通过该 ref 调最新的 React 更新函数
  const bubbleUpdaterRef = useRef<(view: EditorView) => void>(() => {})
  bubbleUpdaterRef.current = (view: EditorView) => {
    const container = containerRef.current
    if (!container) return
    const sel = view.state.selection
    if (sel.empty || !(sel instanceof TextSelection) || !view.hasFocus()) {
      setBubble(null)
      return
    }
    // 代码块内不弹气泡（行内格式无意义）
    if (sel.$from.parent.type.name === 'code_block') {
      setBubble(null)
      return
    }
    try {
      const start = view.coordsAtPos(sel.from)
      const end = view.coordsAtPos(sel.to)
      const rect = container.getBoundingClientRect()
      setBubble({
        top: Math.min(start.top, end.top) - rect.top + container.scrollTop,
        left: (start.left + end.right) / 2 - rect.left + container.scrollLeft
      })
    } catch {
      setBubble(null)
    }
  }

  const { get } = useEditor((root) => {
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, value)
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown !== prevMarkdown) {
            onChangeRef.current(markdown)
          }
        })
        // REQ-107：专注/打字机模式跟随光标。监听挂在编辑器实例上，随编辑器销毁自动清理。
        ctx.get(listenerCtx).selectionUpdated((_ctx) => {
          const view = safeGetView(_ctx)
          if (!view) return
          if (focusModeRef.current) markCurrentBlock(view)
          if (typewriterRef.current) scrollCursorToCenter(view, containerRef.current)
          // 选区气泡菜单跟随选区
          bubbleUpdaterRef.current(view)
        })
        // 空文档占位提示（placeholder prop；未提供时用插件默认文案）
        if (placeholder) {
          ctx.set(placeholderTextCtx.key, placeholder)
        }
        // 让 slash 能延迟拿到 editor 实例
        editorGetterRef.current = () => editor
      })
      .config(nord)
      .config(configureSlashProvider(() => editorGetterRef.current()))
      .use(commonmark)
      .use(gfm)
      // REQ-105：覆盖 table schema 的 toMarkdown，合并单元格时输出 HTML 表格（保留合并）
      .use(tableMergeSchema)
      .use(listener)
      .use(history)
      .use(prism)
      // LaTeX 公式
      .use(remarkMathPlugin)
      .use(mathInlineSchema)
      .use(mathInlineView)
      .use(mathBlockSchema)
      .use(mathBlockView)
      // Mermaid 图表
      .use(remarkMermaid)
      .use(mermaidSchema)
      .use(mermaidView)
      // REQ-106 扩展内联标记（高亮/下划线/上标/下标）
      .use(remarkExtraMarks)
      // REQ-104 脚注（编辑端可点击滚动到定义）
      .use(remarkFootnoteLinks)
      .use(highlightMark)
      .use(underlineMark)
      .use(superscriptMark)
      .use(subscriptMark)
      .use(toggleHighlight)
      .use(toggleUnderline)
      .use(toggleSuperscript)
      .use(toggleSubscript)
      // 斜杠命令
      .use(slash)
      // 空文档占位提示
      .use(placeholderTextCtx)
      .use(placeholderPlugin)
    return editor
  }, [])

  // 避免 get 未使用告警（get() 可用于外部命令调用）
  void get

  // REQ-101：暴露命令式接口（查找替换）
  useEffect(() => {
    if (!onApi) return
    const api: MilkdownEditorApi = {
      isReady: () => !!editorGetterRef.current(),
      // 在文档纯文本中定位第 occurrence 次出现（0 起）并选中。
      // 找不到第 N 处时回退到第一处（markdown 偏移与纯文本计数存在近似差）。
      selectTextOccurrence: (text, occurrence) => {
        const editor = editorGetterRef.current()
        if (!editor || !text) return
        editor.action((ctx) => {
          const view = safeGetView(ctx)
          if (!view) return
          const docText = view.state.doc.textContent
          let from = findNthOccurrence(docText, text, occurrence)
          if (from === -1 && occurrence > 0) from = docText.indexOf(text)
          if (from === -1) return
          const posFrom = textOffsetToPos(view.state.doc, from)
          const posTo = textOffsetToPos(view.state.doc, from + text.length)
          try {
            const tr = view.state.tr
            tr.setSelection(TextSelection.create(view.state.doc, posFrom, posTo)).scrollIntoView()
            view.dispatch(tr)
            view.focus()
          } catch {
            // 选区落在非法位置（如原子节点边界）时忽略本次定位
          }
        })
      },
      replaceTextOccurrence: (text, occurrence, replacement) => {
        const editor = editorGetterRef.current()
        if (!editor || !text) return
        editor.action((ctx) => {
          const view = safeGetView(ctx)
          if (!view) return
          const docText = view.state.doc.textContent
          let from = findNthOccurrence(docText, text, occurrence)
          if (from === -1 && occurrence > 0) from = docText.indexOf(text)
          if (from === -1) return
          const posFrom = textOffsetToPos(view.state.doc, from)
          const posTo = textOffsetToPos(view.state.doc, from + text.length)
          const tr = view.state.tr
          tr.insertText(replacement, posFrom, posTo).scrollIntoView()
          view.dispatch(tr)
          view.focus()
        })
      },
      insertMarkdown: (text) => {
        insertTextAtCursor(text)
      },
      runTableCommand: (cmd) => {
        const editor = editorGetterRef.current()
        if (!editor) return
        editor.action((ctx) => {
          const cmds = ctx.get(commandsCtx)
          switch (cmd) {
            case 'addRowBefore':
              cmds.call(addRowBeforeCommand.key)
              break
            case 'addRowAfter':
              cmds.call(addRowAfterCommand.key)
              break
            case 'addColBefore':
              cmds.call(addColBeforeCommand.key)
              break
            case 'addColAfter':
              cmds.call(addColAfterCommand.key)
              break
            case 'deleteCells':
              cmds.call(deleteSelectedCellsCommand.key)
              break
            case 'alignLeft':
              cmds.call(setAlignCommand.key, { alignment: 'left' })
              break
            case 'alignCenter':
              cmds.call(setAlignCommand.key, { alignment: 'center' })
              break
            case 'alignRight':
              cmds.call(setAlignCommand.key, { alignment: 'right' })
              break
            case 'selectRow':
              cmds.call(selectRowCommand.key)
              break
            case 'selectCol':
              cmds.call(selectColCommand.key)
              break
            case 'mergeCells': {
              // 合并需要在 CellSelection（多选）下进行；直接调用 prosemirror-tables 命令
              const view = safeGetView(ctx)
              if (!view) break
              mergeCells(view.state, (tr) => view.dispatch(tr))
              break
            }
            case 'splitCell': {
              const view = safeGetView(ctx)
              if (!view) break
              splitCell(view.state, (tr) => view.dispatch(tr))
              break
            }
          }
        })
      },
      isInTable: () => {
        const editor = editorGetterRef.current()
        if (!editor) return false
        let inTable = false
        editor.action((ctx) => {
          const view = safeGetView(ctx)
          if (!view) return
          let pos = view.state.selection.$from
          for (let d = pos.depth; d > 0; d--) {
            if (pos.node(d).type.name === 'table_row' || pos.node(d).type.name === 'table') {
              inTable = true
              break
            }
          }
        })
        return inTable
      },
      hasCellSelection: () => {
        const editor = editorGetterRef.current()
        if (!editor) return false
        let result = false
        editor.action((ctx) => {
          const view = safeGetView(ctx)
          if (!view) return
          result = view.state.selection instanceof CellSelection
        })
        return result
      },
      isMergedCell: () => {
        const editor = editorGetterRef.current()
        if (!editor) return false
        let result = false
        editor.action((ctx) => {
          const view = safeGetView(ctx)
          if (!view) return
          const sel = view.state.selection
          // 当前选区所在单元格的 colspan/rowspan > 1 即为可拆分
          const $pos = sel.$from
          for (let d = $pos.depth; d > 0; d--) {
            const node = $pos.node(d)
            if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
              result = node.attrs.colspan > 1 || node.attrs.rowspan > 1
              return
            }
          }
        })
        return result
      }
    }
    onApi(api)
  }, [onApi])

  // REQ-107：Focus 模式 — 光标所在顶层块保持不透明，其余淡化（CSS 实现）。
  // 运行时的 is-current 维护在编辑器 selectionUpdated 监听里（见上方 config）；
  // 这里只处理开关切换：开启时立即标记当前块，关闭时清除全部标记。
  useEffect(() => {
    const pm = containerRef.current?.querySelector('.ProseMirror') as HTMLElement | null
    if (!pm) return
    if (!focusMode) {
      pm.querySelectorAll('.is-current').forEach((el) => el.classList.remove('is-current'))
      return
    }
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (view) markCurrentBlock(view)
    })
  }, [focusMode])

  // REQ-107：打字机模式 — 滚动容器是外层 .milkdown-editor 而非 .ProseMirror，
  // 光标居中逻辑在编辑器 selectionUpdated 监听里（见上方 config），无需单独事件监听。

  // REQ-113：拼写检查
  useEffect(() => {
    const pm = containerRef.current?.querySelector('.ProseMirror') as HTMLElement | null
    if (!pm) return
    pm.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
    if (spellcheck) pm.focus()
  }, [spellcheck])

  // REQ-004：在光标处插入图片节点（通过 ProseMirror 事务，使用 commonmark 的 image schema）。
  const insertImageNode = (url: string, alt = '') => {
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const { tr, schema } = view.state
      const imageNode = schema.nodes.image?.create({ src: url, alt })
      if (!imageNode) return
      view.dispatch(tr.replaceSelectionWith(imageNode))
    })
  }

  // REQ-004：删除编辑器内所有 src 匹配的图片节点。
  const removeImageNodes = (url: string) => {
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const { tr, doc } = view.state
      let adapted = false
      const positions: number[] = []
      doc.descendants((node, pos) => {
        if (node.type.name === 'image' && node.attrs.src === url) {
          positions.push(pos)
          return false
        }
        return true
      })
      // 从后往前删，避免位置偏移。
      for (const pos of positions.reverse()) {
        tr.delete(pos, pos + 1)
        adapted = true
      }
      if (adapted) view.dispatch(tr)
    })
  }

  // REQ-004：图片右键菜单（冒泡方案：在外层 div 监听 contextmenu，从 target 取 src）。
  const imgMenu = useImageContextMenu()
  const [menuUrl, setMenuUrl] = useState<string | null>(null)
  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target instanceof HTMLImageElement && target.currentSrc.startsWith('noteweave-asset:')) {
      e.preventDefault()
      setMenuUrl(target.currentSrc)
      imgMenu.openFromEvent({ src: target.currentSrc, x: e.clientX, y: e.clientY })
    }
  }
  const handleDeleteImage = async (url: string) => {
    const okDelete = await confirm({
      title: '删除图片',
      description: '确定删除该图片？将从文档中移除引用并删除文件。',
      confirmText: '删除',
      danger: true
    })
    if (!okDelete) return
    const ok = await window.electronAPI.deleteAsset(url)
    if (ok) {
      removeImageNodes(url)
    } else {
      toast.danger('删除失败：文件可能已被移动或删除。')
    }
  }

  // REQ-016：在光标处插入附件链接文本。
  const insertTextAtCursor = (text: string) => {
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const { tr, selection } = view.state
      view.dispatch(tr.insertText(text, selection.from))
    })
  }

  // REQ-004/016：粘贴 / 拖拽图片或附件。图片插入为图片节点；附件以链接文本形式插入。
  const handlePasteOrDrop = async (
    files: File[] | undefined,
    e: React.SyntheticEvent
  ): Promise<void> => {
    if (!assetScope || !files || files.length === 0) return
    e.preventDefault()
    for (const file of files) {
      const md = await uploadFile(file, assetScope.scope, assetScope.ownerId)
      const imgMatch = md.match(/^!\[[^\]]*\]\(([^)]+)\)$/)
      if (imgMatch) {
        insertImageNode(imgMatch[1])
      } else {
        insertTextAtCursor(md)
      }
    }
  }

  // 选区气泡菜单：格式化命令（加粗/斜体/删除线/高亮/行内代码）
  const runBubbleToggle = (action: BubbleAction) => {
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const cmds = ctx.get(commandsCtx)
      switch (action) {
        case 'bold':
          cmds.call(toggleStrongCommand.key)
          break
        case 'italic':
          cmds.call(toggleEmphasisCommand.key)
          break
        case 'strike':
          cmds.call(toggleStrikethroughCommand.key)
          break
        case 'highlight':
          cmds.call(extraMarksCommands.highlight)
          break
        case 'code':
          cmds.call(toggleInlineCodeCommand.key)
          break
      }
    })
  }

  // 气泡按钮高亮：判断格式是否覆盖当前选区
  const isBubbleActive = (action: BubbleAction): boolean => {
    const markName =
      action === 'bold'
        ? 'strong'
        : action === 'italic'
          ? 'emphasis'
          : action === 'strike'
            ? 'strike_through'
            : action === 'highlight'
              ? 'highlight'
              : 'inlineCode'
    const editor = editorGetterRef.current()
    if (!editor) return false
    let active = false
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const type = view.state.schema.marks[markName]
      if (!type) return
      const { from, to, empty } = view.state.selection
      active = empty
        ? !!type.isInSet(view.state.storedMarks ?? view.state.selection.$from.marks())
        : view.state.doc.rangeHasMark(from, to, type)
    })
    return active
  }

  // 当前选区上的链接地址（无则空串）
  const getCurrentLinkHref = (): string => {
    const editor = editorGetterRef.current()
    if (!editor) return ''
    let href = ''
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const linkType = view.state.schema.marks.link
      if (!linkType) return
      const { from, to } = view.state.selection
      view.state.doc.nodesBetween(from, to, (node) => {
        const mark = node.marks.find((m) => m.type === linkType)
        if (mark) {
          href = (mark.attrs.href as string) ?? ''
          return false
        }
        return true
      })
    })
    return href
  }

  // 应用/移除链接（href 为空串 = 移除）
  const applyLinkToSelection = (href: string) => {
    const editor = editorGetterRef.current()
    if (!editor) return
    editor.action((ctx) => {
      const view = safeGetView(ctx)
      if (!view) return
      const linkType = view.state.schema.marks.link
      if (!linkType) return
      const { tr, selection } = view.state
      const { from, to } = selection
      if (from === to) return
      tr.removeMark(from, to, linkType)
      if (href) {
        tr.addMark(from, to, linkType.create({ href }))
      }
      view.dispatch(tr.scrollIntoView())
      view.focus()
    })
  }

  // REQ-114：自动配对（成对符号补全 / 跳过 / 选区包裹）
  useEffect(() => {
    if (!autoPair) return
    const pm = containerRef.current?.querySelector('.ProseMirror') as HTMLElement | null
    if (!pm) return
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' }
    const handler = (e: KeyboardEvent) => {
      const close = pairs[e.key]
      if (!close) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      // 选区包裹
      if (!sel.isCollapsed && e.key.length === 1) {
        e.preventDefault()
        const range = sel.getRangeAt(0)
        const text = sel.toString()
        range.deleteContents()
        const node = document.createTextNode(e.key + text + close)
        range.insertNode(node)
        // 选中内部文本
        const newRange = document.createRange()
        newRange.setStartAfter(node)
        newRange.setStart(node, 1)
        newRange.setEnd(node, 1 + text.length)
        sel.removeAllRanges()
        sel.addRange(newRange)
        return
      }
      // 输入左符号自动补全右符号
      if (e.key !== close || e.key === '"' || e.key === "'") {
        if (e.key.length === 1 && pairs[e.key]) {
          e.preventDefault()
          const range = sel.getRangeAt(0)
          range.deleteContents()
          const node = document.createTextNode(e.key + close)
          range.insertNode(node)
          const r = document.createRange()
          r.setStart(node, 1)
          r.collapse(true)
          sel.removeAllRanges()
          sel.addRange(r)
        } else if (e.key === close) {
          // 输入右符号且右侧已是该符号 → 跳过
          const range = sel.getRangeAt(0)
          const after = range.endContainer.textContent?.[range.endOffset]
          if (after === close) {
            e.preventDefault()
            const r = document.createRange()
            r.setStart(range.endContainer, range.endOffset + 1)
            r.collapse(true)
            sel.removeAllRanges()
            sel.addRange(r)
          }
        }
      }
    }
    pm.addEventListener('keydown', handler, true)
    return () => pm.removeEventListener('keydown', handler, true)
  }, [autoPair])

  return (
    <div
      ref={containerRef}
      className={`milkdown-editor relative h-full overflow-auto px-1 py-2 ${focusMode ? 'focus-mode' : ''} ${typewriterMode ? 'typewriter-mode' : ''}`}
      onContextMenu={handleContextMenu}
      // REQ-104：点击脚注引用滚动到对应定义（由 remarkFootnoteLinks 生成的 <a href="#fn-id">）
      onClick={(e) => {
        const target = e.target as HTMLElement
        const anchor = target.closest('a[data-footnote-ref]') as HTMLAnchorElement | null
        if (!anchor) return
        const href = anchor.getAttribute('href') || ''
        if (!href.startsWith('#fn-')) return
        e.preventDefault()
        const id = href.slice(1)
        const def = containerRef.current?.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null
        def?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }}
      onPaste={(e) => {
        const files = e.clipboardData?.files ? Array.from(e.clipboardData.files) : []
        void handlePasteOrDrop(files, e)
      }}
      onDrop={(e) => {
        const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
        void handlePasteOrDrop(files, e)
      }}
      onDragOver={(e) => {
        if (assetScope && e.dataTransfer?.types?.includes('Files')) e.preventDefault()
      }}
      onBlur={(e) => {
        // 焦点离开编辑器（且未落入气泡菜单）时收起气泡
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBubble(null)
      }}
      onKeyDown={(e) => {
        // Ctrl+K：选区非空时唤起气泡菜单的链接输入框（替代 window.prompt）
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
          const editor = editorGetterRef.current()
          if (!editor) return
          let hasSelection = false
          editor.action((ctx) => {
            const view = safeGetView(ctx)
            hasSelection = view ? !view.state.selection.empty : false
          })
          if (!hasSelection) return
          e.preventDefault()
          setLinkSignal((n) => n + 1)
        }
      }}
    >
      <Milkdown />
      {bubble && (
        <SelectionBubble
          position={bubble}
          isActive={isBubbleActive}
          onToggle={runBubbleToggle}
          getCurrentLink={getCurrentLinkHref}
          onApplyLink={applyLinkToSelection}
          linkSignal={linkSignal}
        />
      )}
      {imgMenu.menu && menuUrl && (
        <ImageContextMenu
          position={{ x: imgMenu.menu.x, y: imgMenu.menu.y }}
          imageUrl={menuUrl}
          onClose={imgMenu.close}
          onCopy={imgMenu.copyImage}
          onView={imgMenu.viewImage}
          onShowInFolder={imgMenu.showInFolder}
          onDelete={async (url) => {
            imgMenu.close()
            await handleDeleteImage(url)
          }}
        />
      )}
    </div>
  )
}

export function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <MilkdownEditorInner {...props} />
    </MilkdownProvider>
  )
}
