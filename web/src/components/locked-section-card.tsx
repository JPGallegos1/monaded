import { Lock } from 'lucide-react'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'

/**
 * Skeleton placeholder for a locked study section.
 * Must NEVER receive real gated copy — only an optional title + decorative bars.
 */
export function LockedSectionCard({
  title,
  message = 'Unlock with a license',
  className,
}: {
  /** Real section title from the public API, when available. */
  title?: string
  /** Overlay copy. Generic single-block preview uses a different string. */
  message?: string
  className?: string
}) {
  return (
    <Card
      className={cn('relative overflow-hidden p-5', className)}
      data-marketplace="locked-section"
      aria-label={title ? `${title} — locked` : message}
    >
      {title ? (
        <p className="mb-4 text-[15px] font-semibold text-muted-foreground">{title}</p>
      ) : (
        <p className="mb-4 text-[15px] font-semibold text-transparent select-none" aria-hidden>
          &nbsp;
        </p>
      )}
      <div className="flex flex-col gap-2.5" aria-hidden>
        <div className="h-3 w-full rounded-md bg-muted" />
        <div className="h-3 w-[82%] rounded-md bg-muted" />
        <div className="h-3 w-[64%] rounded-md bg-muted" />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/70 backdrop-blur-[2px]">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{message}</p>
      </div>
    </Card>
  )
}

/**
 * Public section titles for locked cards.
 * Returns only real titles from the API — never invents "Section N" placeholders.
 * Empty array → caller should render a single generic locked block.
 */
export function lockedSectionTitles(fromApi: string[] | undefined): string[] {
  if (!fromApi || fromApi.length === 0) return []
  return fromApi.filter((t) => typeof t === 'string' && t.trim().length > 0)
}
