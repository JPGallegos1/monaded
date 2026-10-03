import { cn } from '#/lib/utils'
import type { HTMLAttributes } from 'react'

type Variant = 'default' | 'outline' | 'success' | 'muted'

const variants: Record<Variant, string> = {
  default: 'bg-accent text-accent-foreground',
  outline: 'border border-border text-muted-foreground bg-transparent',
  success: 'bg-success-soft text-success',
  muted: 'bg-muted text-muted-foreground',
}

export function Badge({
  className,
  variant = 'default',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}
