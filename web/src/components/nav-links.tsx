import { Link } from '@tanstack/react-router'
import { Upload } from 'lucide-react'
import { cn } from '#/lib/utils'

/** CTA that looks like the primary button but navigates with TanStack Link. */
export function PrimaryLink({
  to,
  children,
  className,
  icon,
}: {
  to: string
  children: React.ReactNode
  className?: string
  icon?: boolean
}) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground no-underline hover:opacity-90',
        className,
      )}
    >
      {icon && <Upload className="h-4 w-4" />}
      {children}
    </Link>
  )
}

export function SecondaryLink({
  to,
  children,
  className,
}: {
  to: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground no-underline hover:bg-muted',
        className,
      )}
    >
      {children}
    </Link>
  )
}
