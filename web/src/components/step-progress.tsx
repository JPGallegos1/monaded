import { Check, Circle, Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '#/lib/utils'

export type StepState = 'done' | 'active' | 'todo'

const meta: Record<
  StepState,
  { icon: LucideIcon; fill: string; status: string; statusColor: string; iconColor: string }
> = {
  done: {
    icon: Check,
    fill: 'bg-success',
    status: 'Done',
    statusColor: 'text-success',
    iconColor: 'text-primary-foreground',
  },
  active: {
    icon: Loader2,
    fill: 'bg-primary',
    status: 'In progress',
    statusColor: 'text-primary',
    iconColor: 'text-primary-foreground',
  },
  todo: {
    icon: Circle,
    fill: 'bg-muted',
    status: 'Waiting',
    statusColor: 'text-muted-foreground',
    iconColor: 'text-muted-foreground',
  },
}

export function StepItem({
  title,
  detail,
  state = 'todo',
  className,
}: {
  title: string
  detail: string
  state?: StepState
  className?: string
}) {
  const m = meta[state]
  const Icon = m.icon
  return (
    <div className={cn('flex w-full items-center gap-3 py-3', className)}>
      <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', m.fill)}>
        <Icon className={cn('h-3.5 w-3.5', m.iconColor, state === 'active' && 'animate-spin-slow')} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-[13px] text-muted-foreground">{detail}</p>
      </div>
      <span className={cn('text-xs font-medium', m.statusColor)}>{m.status}</span>
    </div>
  )
}

export function StepProgress({
  steps,
  progress = 0,
  stepLabel,
  eta,
}: {
  steps: { title: string; detail: string; state: StepState }[]
  progress?: number
  stepLabel?: string
  eta?: string
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all duration-500"
          style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
      </div>
      {(stepLabel || eta) && (
        <div className="flex justify-between text-[13px] font-medium text-muted-foreground">
          <span>{stepLabel}</span>
          <span>{eta}</span>
        </div>
      )}
      <div className="flex flex-col">
        {steps.map((s) => (
          <StepItem key={s.title} {...s} />
        ))}
      </div>
    </div>
  )
}
