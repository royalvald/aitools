import { useCallback, useEffect, useState } from 'react'
import type { Todo, TodoTargetType } from '../types'

/**
 * 管理全局待办任务列表。
 *
 * 待办是离散动作（添加 / 完成 / 编辑 / 删除），采用即时保存：每次操作直接落盘并刷新列表，
 * 不做防抖。与 useKbDocAnnotations 的模式一致。
 */
export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const load = useCallback(async () => {
    setIsLoading(true)
    try {
      const list = await window.electronAPI.listTodos()
      setTodos(list)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = useCallback(
    async (
      title: string,
      detail: string,
      targetType: TodoTargetType,
      targetId: string,
      kbId?: string
    ): Promise<Todo> => {
      const todo = await window.electronAPI.createTodo(title, detail, targetType, targetId, kbId)
      await load()
      return todo
    },
    [load]
  )

  const save = useCallback(
    async (todo: Todo): Promise<Todo> => {
      const updated = await window.electronAPI.saveTodo(todo)
      await load()
      return updated
    },
    [load]
  )

  const toggleDone = useCallback(
    async (todo: Todo): Promise<Todo> => {
      const updated = await window.electronAPI.saveTodo({ ...todo, done: !todo.done })
      await load()
      return updated
    },
    [load]
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const ok = await window.electronAPI.deleteTodo(id)
      if (ok) {
        await load()
      }
      return ok
    },
    [load]
  )

  return { todos, isLoading, load, create, save, toggleDone, remove }
}
