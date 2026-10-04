import { Coins, Rocket } from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'

/**
 * Creator earnings panel (dashboard).
 *
 * TODO(pr-6): wire props from the Creator Economy indexer (sales, royalties)
 * once https://github.com/JPGallegos1/monaded/pull/6 merges. Until then the
 * dashboard always passes a zero total so the empty state renders.
 */

export type EarningsTxType = 'sale' | 'royalty'

export type EarningsTransaction = {
  id: string
  /** Template title shown in the row. */
  templateTitle: string
  type: EarningsTxType
  /** Required when type === 'royalty' (1–3). */
  royaltyLevel?: number
  /** Amount in MON (decimal string or number). Displayed with a green "+". */
  amountMon: string | number
  /** ISO timestamp or Date — rendered as relative time. */
  at: string | Date
}

export type EarningsCardProps = {
  /** Total earned in MON. Empty state shows while this is zero. */
  totalEarnedMon: string | number
  salesMon: string | number
  forkRoyaltiesMon: string | number
  /** Latest transactions; UI shows at most 5. */
  transactions?: EarningsTransaction[]
  onPublish?: () => void
  className?: string
}

export function EarningsCard({
  totalEarnedMon,
  salesMon,
  forkRoyaltiesMon,
  transactions = [],
  onPublish,
  className,
}: EarningsCardProps) {
  const total = toNumber(totalEarnedMon)
  const isEmpty = total <= 0

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

  const latest = transactions.slice(0, 5)

  return (
    <Card className={cn('flex flex-col gap-4 p-5', className)}>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-muted-foreground">Total earned</span>
        <p className="font-mono text-[28px] font-bold tracking-tight text-foreground">
          {formatAmount(totalEarnedMon)} MON
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Sales {formatAmount(salesMon)} MON</span>
          <span>Fork royalties {formatAmount(forkRoyaltiesMon)} MON</span>
        </div>
      </div>

      {latest.length > 0 && (
        <ul className="flex flex-col gap-2.5 border-t border-border pt-3">
          {latest.map((tx) => (
            <li key={tx.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{tx.templateTitle}</p>
                <p className="text-xs text-muted-foreground">
                  {tx.type === 'sale'
                    ? 'Sale'
                    : `Royalty · Level ${tx.royaltyLevel ?? '—'}`}
                  {' · '}
                  {relativeTime(tx.at)}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm font-semibold text-success">
                +{formatAmount(tx.amountMon)} MON
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function toNumber(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function formatAmount(v: string | number): string {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(v)
  }
  return v.trim() || '0'
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
