import { Lock } from 'lucide-react'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'

/**
 * Skeleton placeholder for a locked study section.
 * Must NEVER receive real gated copy — only a title label + decorative bars.
 */
export function LockedSectionCard({
  title,
  className,
}: {
  title: string
  className?: string
}) {
  return (
    <Card
      className={cn('relative overflow-hidden p-5', className)}
      data-marketplace="locked-section"
      aria-label={`${title} — locked`}
    >
      <p className="mb-4 text-[15px] font-semibold text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-2.5" aria-hidden>
        <div className="h-3 w-full rounded-md bg-muted" />
        <div className="h-3 w-[82%] rounded-md bg-muted" />
        <div className="h-3 w-[64%] rounded-md bg-muted" />
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/70 backdrop-blur-[2px]">
        <Lock className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Unlock with a license</p>
      </div>
    </Card>
  )
}

/** Default locked shells when the public API returns no section titles. */
export const DEFAULT_LOCKED_SECTION_COUNT = 3

export function lockedSectionTitles(fromApi: string[] | undefined): string[] {
  if (fromApi && fromApi.length > 0) return fromApi
  return Array.from({ length: DEFAULT_LOCKED_SECTION_COUNT }, (_, i) => `Section ${i + 1}`)
}
