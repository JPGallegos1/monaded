import { Link } from '@tanstack/react-router'
import { Coins, Loader2, Rocket } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'

/**
 * Creator earnings panel (dashboard).
 * Presentational — callers wire /me/earnings + on-chain pendingWithdrawals / withdraw().
 */

export type EarningsRecentRow = {
  id: string
  kind: 'sale' | 'royalty'
  onchainTemplateId: string
  templateId: string | null
  templateTitle: string | null
  amountMon: string
  royaltyLevel: number | null
  at: string | Date
}

export type EarningsCardProps = {
  /** Total earned in MON (from /me/earnings totals.earned). */
  totalEarnedMon: string
  salesMon: string
  forkRoyaltiesMon: string
  /** Live pending from pendingWithdrawals(0x0, wallet) — not the indexer field. */
  pendingMon: string
  pendingWei: bigint
  recent?: EarningsRecentRow[]
  /** True while earnings API is loading or unavailable endpoints are resolving. */
  loading?: boolean
  withdrawing?: boolean
  onPublish?: () => void
  onWithdraw?: () => void
  className?: string
}

export function EarningsCard({
  totalEarnedMon,
  salesMon,
  forkRoyaltiesMon,
  pendingMon,
  pendingWei,
  recent = [],
  loading,
  withdrawing,
  onPublish,
  onWithdraw,
  className,
}: EarningsCardProps) {
  const earnedZero = isZeroAmount(totalEarnedMon)
  const pendingZero = pendingWei === 0n
  const isEmpty = earnedZero && pendingZero

  if (loading && isEmpty) {
    return (
      <Card className={cn('flex flex-col gap-2 p-5', className)}>
        <p className="text-sm text-muted-foreground">Loading earnings…</p>
      </Card>
    )
  }

  if (isEmpty) {
    return (
      <Card className={cn('flex flex-col items-start gap-2.5 p-5', className)}>
        <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent text-accent-foreground">
          <Coins className="h-5 w-5" />
        </div>
        <p className="text-base font-semibold">Earnings appear here after your first sale</p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Sales and fork royalties are paid in MON, straight to your wallet.
        </p>
        <Button onClick={onPublish}>
          <Rocket className="h-4 w-4" />
          Publish a template
        </Button>
      </Card>
    )
  }

  const latest = recent.slice(0, 5)
  const showPending = !pendingZero

  return (
    <Card className={cn('flex flex-col gap-4 p-5', className)} data-marketplace="earnings">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-muted-foreground">Total earned</span>
        <p className="font-mono text-[28px] font-bold tracking-tight text-foreground">
          {totalEarnedMon} MON
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Sales {salesMon} MON</span>
          <span>Fork royalties {forkRoyaltiesMon} MON</span>
        </div>
      </div>

      {showPending && (
        <div className="flex items-center justify-between gap-3 rounded-md bg-accent px-3.5 py-2.5">
          <span className="text-sm font-medium text-accent-foreground">
            Pending: {pendingMon} MON
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={withdrawing || !onWithdraw}
            onClick={onWithdraw}
          >
            {withdrawing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Withdrawing…
              </>
            ) : (
              'Withdraw'
            )}
          </Button>
        </div>
      )}

      {latest.length > 0 && (
        <ul className="flex flex-col gap-2.5 border-t border-border pt-3">
          {latest.map((tx) => (
            <li key={tx.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">
                  {tx.templateId ? (
                    <Link
                      to="/templates/$templateId"
                      params={{ templateId: tx.templateId }}
                      className="text-foreground no-underline hover:text-primary"
                    >
                      {tx.templateTitle || `Template #${tx.onchainTemplateId}`}
                    </Link>
                  ) : (
                    <>Template #{tx.onchainTemplateId}</>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tx.kind === 'sale'
                    ? 'Sale'
                    : `Royalty · Level ${tx.royaltyLevel ?? '—'}`}
                  {' · '}
                  {relativeTime(tx.at)}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-success">
                +{tx.amountMon} MON
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function isZeroAmount(v: string): boolean {
  const n = Number(v)
  return !Number.isFinite(n) || n === 0
}

function relativeTime(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return '—'
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
