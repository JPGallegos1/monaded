import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '#/lib/utils'

type ToastItem = {
  id: number
  content: ReactNode
}

type Listener = (items: ToastItem[]) => void

let nextId = 1
let items: ToastItem[] = []
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l(items)
}

/** Imperative toast — no extra dependency. */
export function showToast(content: ReactNode, durationMs = 6000) {
  const id = nextId++
  items = [...items, { id, content }]
  emit()
  window.setTimeout(() => {
    items = items.filter((t) => t.id !== id)
    emit()
  }, durationMs)
  return id
}

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

/** Mount once near the app root (e.g. __root). */
export function ToastHost({ className }: { className?: string }) {
  const [toasts, setToasts] = useState<ToastItem[]>(items)

  useEffect(() => {
    listeners.add(setToasts)
    return () => {
      listeners.delete(setToasts)
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      className={cn(
        'pointer-events-none fixed bottom-6 right-6 z-[200] flex w-[min(100%-2rem,360px)] flex-col gap-2',
        className,
      )}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-card p-3.5 shadow-elevated"
        >
          <div className="min-w-0 flex-1 text-sm text-foreground">{t.content}</div>
          <button
            type="button"
            onClick={() => dismissToast(t.id)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
