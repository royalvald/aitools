import { useCallback, useEffect, useState } from 'react'
import type { Todo, TodoTargetType } from '../types'

/**
 * 加载并管理「隶属于某个目标对象（note / kbDoc）」的待办列表。
 *
 * 与全局 useTodos（聚合视图用）不同：本 hook 按 targetType + targetId 过滤，
 * 用于在笔记 / 文档详情页底部展示「该对象下的所有待办」，并就地完成
 * 创建 / 切换完成 / 删除。
 *
 * 待办是离散动作，采用即时保存（无防抖）：每次操作落盘后重新拉取，确保列表与
 * .todos.json 一致，也方便父组件反映最新的待办计数。
 *
 * @param targetType 关联对象类型
 * @param targetId   关联对象 id；为 null 时表示当前无选中对象，不加载任何待办
 * @param kbId       targetType==='kbDoc' 时传入所属知识库 id（仅用于创建时回填）
 */
export function useTodosForTarget(
  targetType: TodoTargetType,
  targetId: string | null | undefined,
  kbId?: string
) {
  const [todos, setTodos] = useState<Todo[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const load = useCallback(async () => {
    if (!targetId) {
      setTodos([])
      return
    }
    setIsLoading(true)
    try {
      // 全局列表已按「未完成在前 + updatedAt 倒序」排序，这里仅按目标过滤
      const all = await window.electronAPI.listTodos()
      const filtered = all.filter((t) => t.targetType === targetType && t.targetId === targetId)
      setTodos(filtered)
    } finally {
      setIsLoading(false)
    }
  }, [targetType, targetId])

  useEffect(() => {
    load()
  }, [load])

  const create = useCallback(
    async (title: string, detail: string): Promise<Todo | null> => {
      if (!targetId) return null
      const todo = await window.electronAPI.createTodo(title, detail, targetType, targetId, kbId)
      await load()
      return todo
    },
    [targetType, targetId, kbId, load]
  )

  const toggleDone = useCallback(
    async (todo: Todo): Promise<void> => {
      await window.electronAPI.saveTodo({ ...todo, done: !todo.done })
      await load()
    },
    [load]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await window.electronAPI.deleteTodo(id)
      await load()
    },
    [load]
  )

  return { todos, isLoading, load, create, toggleDone, remove }
}
