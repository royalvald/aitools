import { useState } from 'react'
import { Lock } from 'lucide-react'

// REQ-208 锁屏界面：输入密码后解锁。
interface LockScreenProps {
  onUnlock: (password: string) => Promise<boolean>
}

export function LockScreen({ onUnlock }: LockScreenProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password.trim()) {
      setError('请输入密码')
      return
    }
    setSubmitting(true)
    setError('')
    const ok = await onUnlock(password)
    setSubmitting(false)
    if (!ok) {
      setError('密码错误')
      setPassword('')
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[var(--color-background)]">
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-accent-soft)]">
          <Lock className="h-8 w-8 text-[var(--color-accent)]" />
        </div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">织记已锁定</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">输入密码以继续</p>
        <form onSubmit={submit} className="flex w-72 flex-col gap-3">
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)] outline-none focus:border-[var(--color-accent)]"
          />
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? '验证中…' : '解锁'}
          </button>
        </form>
      </div>
    </div>
  )
}
