import type { LucideIcon } from 'lucide-react'
import { cn } from '#/lib/utils'

export function StatCard({
  label,
  value,
  delta,
  icon: Icon,
  deltaMuted,
  className,
}: {
  label: string
  value: string
  delta?: string
  icon?: LucideIcon
  deltaMuted?: boolean
  className?: string
}) {
  return (
    <div className={cn('surface-card flex flex-col gap-1.5 p-5', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </div>
      <p className="font-display text-[28px] font-bold tracking-tight text-foreground">{value}</p>
      {delta && (
        <p className={cn('text-xs font-medium', deltaMuted ? 'text-muted-foreground' : 'text-success')}>
          {delta}
        </p>
      )}
    </div>
  )
}
