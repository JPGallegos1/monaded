import { GitFork, ShieldCheck } from 'lucide-react'
import { MonPrice } from '#/components/mon-price'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * Presentational purchase / fork actions for template detail (design 07).
 * Wire `onBuy` to the Privy/wallet `buy()` call in a separate PR — no chain logic here.
 */
export type BuyLicenseCardProps = {
  price?: number | string | null
  onBuy?: () => void
  onFork?: () => void
  isLoading?: boolean
  owned?: boolean
  meta?: { label: string; value: string }[]
  className?: string
}

export function BuyLicenseCard({
  price,
  onBuy,
  onFork,
  isLoading,
  owned,
  meta = [],
  className,
}: BuyLicenseCardProps) {
  return (
    <aside className={cn('surface-card shadow-elevated flex flex-col gap-3 p-6', className)}>
      <MonPrice amount={price ?? '—'} size="lg" />
      <p className="text-[13px] text-muted-foreground">One-time license · yours forever</p>

      {owned ? (
        <Button className="w-full" disabled>
          You own this license
        </Button>
      ) : (
        <Button className="w-full" onClick={onBuy} disabled={isLoading || price == null}>
          {isLoading ? 'Confirming…' : 'Buy license'}
        </Button>
      )}
      {/* TODO(privy): onBuy → TemplateMarketplace.buy() via embedded wallet */}

      <Button variant="secondary" className="w-full" onClick={onFork} disabled={isLoading}>
        <GitFork className="h-4 w-4" />
        Fork this template
      </Button>

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-success" />
        Paid from your Monaded wallet · fee &lt; 0.001 MON
      </div>

      {meta.length > 0 && (
        <>
          <div className="my-1 h-px w-full bg-border" />
          <dl className="flex flex-col gap-2">
            {meta.map((m) => (
              <div key={m.label} className="flex justify-between text-[13px]">
                <dt className="text-muted-foreground">{m.label}</dt>
                <dd className="font-medium text-foreground">{m.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </aside>
  )
}
