import { Link } from '@tanstack/react-router'
import { GitFork, Ticket } from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { MonPrice } from '#/components/mon-price'
import { cn, coverGradientClass } from '#/lib/utils'

export type TemplateCardProps = {
  id?: string
  title: string
  creator?: string | null
  subject?: string | null
  kind?: string | null
  price?: number | string | null
  forks?: number | null
  licenses?: number | null
  href?: string
  coverSeed?: string | number
  cta?: string
  className?: string
}

export function TemplateCard({
  id,
  title,
  creator,
  subject,
  kind = 'Original',
  price,
  forks,
  licenses,
  href,
  coverSeed,
  cta = 'View',
  className,
}: TemplateCardProps) {
  const to = href ?? (id ? `/templates/${id}` : undefined)
  const body = (
    <article className={cn('surface-card overflow-hidden', className)}>
      <div className={cn('h-[132px] w-full', coverGradientClass(coverSeed ?? title))} />
      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap gap-1.5">
          {subject && <Badge>{subject}</Badge>}
          {kind && <Badge variant="outline">{kind}</Badge>}
        </div>
        <h3 className="text-base font-semibold leading-snug text-foreground">{title}</h3>
        {creator && (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <span className="avatar-gradient h-5 w-5 rounded-full" aria-hidden />
            <span>by {creator}</span>
          </div>
        )}
        <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
          {forks != null && (
            <span className="inline-flex items-center gap-1">
              <GitFork className="h-3.5 w-3.5" />
              {forks} forks
            </span>
          )}
          {licenses != null && (
            <span className="inline-flex items-center gap-1">
              <Ticket className="h-3.5 w-3.5" />
              {licenses} licenses
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <MonPrice amount={price ?? 'Not published'} />
          <Button variant="secondary" size="sm" tabIndex={to ? -1 : undefined}>
            {cta}
          </Button>
        </div>
      </div>
    </article>
  )

  if (!to) return body
  return (
    <Link to={to} className="block no-underline transition hover:-translate-y-0.5">
      {body}
    </Link>
  )
}
