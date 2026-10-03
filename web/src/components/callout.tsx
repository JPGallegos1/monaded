import { BookOpen, type LucideIcon } from 'lucide-react'
import { cn } from '#/lib/utils'

export function Callout({
  kind = 'Definition',
  term,
  body,
  icon: Icon = BookOpen,
  className,
}: {
  kind?: string
  term: string
  body: string
  icon?: LucideIcon
  className?: string
}) {
  return (
    <div className={cn('rounded-md bg-accent p-4', className)}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-accent-foreground">
        <Icon className="h-4 w-4" />
        {kind}
      </div>
      <p className="mb-1 text-[15px] font-semibold text-foreground">{term}</p>
      <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  )
}
