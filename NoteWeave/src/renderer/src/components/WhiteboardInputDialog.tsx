import { useState } from 'react'
import { Modal } from './Modal'

interface WhiteboardInputDialogProps {
  title: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  onSubmit: (value: string) => void
  onClose: () => void
}

/**
 * 白板模块通用单行输入弹窗（框架改名、保存模板等）。
 * 不使用 window.prompt —— Electron 渲染进程默认禁用原生 prompt（静默返回 null）。
 */
export function WhiteboardInputDialog({
  title,
  defaultValue = '',
  placeholder,
  confirmText = '确定',
  onSubmit,
  onClose
}: WhiteboardInputDialogProps) {
  const [value, setValue] = useState(defaultValue)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    onSubmit(value.trim())
    onClose()
  }

  return (
    <Modal title={title} onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="input"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            取消
          </button>
          <button type="submit" disabled={!value.trim()} className="btn-primary disabled:cursor-not-allowed">
            {confirmText}
          </button>
        </div>
      </form>
    </Modal>
  )
}
