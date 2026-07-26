import { useEffect, useRef, useState } from 'react'
import { Bell, Pause, Play, RotateCcw, Timer } from 'lucide-react'
import { cn } from '../lib/utils'

// REQ-226 白板个人记录工具：计时器（倒计时）。
// 工具栏内嵌组件：按钮常显剩余时间，点击展开下拉面板进行设置与控制，不再浮动在画布上。

const PRESETS = [5, 10, 15, 25, 45]

export function WhiteboardTimerButton() {
  const [total, setTotal] = useState(0) // 总秒数（0=未设置）
  const [remaining, setRemaining] = useState(0)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (running && remaining > 0) {
      intervalRef.current = setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            setRunning(false)
            playBeep()
            return 0
          }
          return r - 1
        })
      }, 1000)
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const start = (minutes: number) => {
    setTotal(minutes * 60)
    setRemaining(minutes * 60)
    setRunning(true)
  }
  const toggle = () => {
    if (remaining > 0) setRunning((v) => !v)
  }
  const reset = () => {
    setRunning(false)
    setRemaining(total)
  }

  const mm = Math.floor(remaining / 60)
  const ss = remaining % 60
  const progress = total > 0 ? (remaining / total) * 100 : 0
  const active = total > 0

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'btn-ghost',
          running && 'text-[var(--nw-primary)]'
        )}
        title="计时器"
      >
        <Timer className="h-4 w-4" />
        {active && (
          <span
            className={cn(
              'tabular-nums',
              remaining === 0 ? 'text-[var(--color-danger)]' : undefined
            )}
          >
            {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 surface-elevated p-3">
            {total > 0 ? (
              <>
                <div className="mb-2 text-center">
                  <div className={cn('text-3xl font-bold tabular-nums', remaining === 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-foreground)]')}>
                    {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-muted)]">
                    <div
                      className="h-full rounded-full bg-[var(--nw-primary)] transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  {remaining === 0 && (
                    <div className="mt-1 flex items-center justify-center gap-1 text-[11px] text-[var(--color-danger)]">
                      <Bell className="h-3 w-3" /> 时间到！
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-center gap-1">
                  <button onClick={toggle} disabled={remaining === 0} className="rounded bg-[var(--nw-primary)] p-1.5 text-white hover:bg-[var(--nw-primary-hover)] disabled:opacity-40">
                    {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button onClick={reset} className="rounded border border-[var(--color-border)] p-1.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-2)]">
                    <RotateCcw className="h-4 w-4" />
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((m) => (
                  <button
                    key={m}
                    onClick={() => start(m)}
                    className="flex-1 btn-secondary text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--nw-accent-soft)] hover:text-[var(--nw-primary)]"
                  >
                    {m} 分
                  </button>
                ))}
                <CustomMinutesStarter onStart={start} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function CustomMinutesStarter({ onStart }: { onStart: (m: number) => void }) {
  const [val, setVal] = useState('')
  return (
    <div className="flex w-full items-center gap-1">
      <input
        type="number"
        min={1}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="自定义"
        className="w-20 btn-secondary text-xs outline-none"
      />
      <button
        onClick={() => {
          const m = Number(val)
          if (m > 0) onStart(m)
        }}
        className="rounded-md bg-[var(--color-muted)] px-2 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-border-strong)]"
      >
        开始
      </button>
    </div>
  )
}

// 简单蜂鸣（WebAudio 合成，无需音频资源）
function playBeep(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AudioCtx()
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.5)
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.5 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.5 + 0.4)
      osc.start(ctx.currentTime + i * 0.5)
      osc.stop(ctx.currentTime + i * 0.5 + 0.4)
    }
  } catch {
    // ignore
  }
}
