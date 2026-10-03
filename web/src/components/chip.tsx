import { cn } from '#/lib/utils'

export function Chip({
  active,
  children,
  className,
  onClick,
}: {
  active?: boolean
  children: React.ReactNode
  className?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1.5 text-[13px] font-medium',
        active
          ? 'bg-foreground text-background'
          : 'border border-border bg-card text-foreground hover:bg-muted',
        className,
      )}
    >
      {children}
    </button>
  )
}
